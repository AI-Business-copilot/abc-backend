import { Prisma } from "@prisma/client";

import { HttpError } from "../../shared/http/http-error";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { businessDataService } from "../business-data/business-data.service";
import { analyze, nextStatus } from "./engine";
import { DEFAULT_SETTINGS, resolveSettings } from "./settings";
import { addDays, buildSnapshot, businessToday, windowStart } from "./snapshot/build-snapshot";
import {
  INSIGHT_STATUSES,
  INSIGHT_TYPES,
  SEVERITIES,
  type InsightSettings,
  type InsightStatus,
  type InsightType,
  type Severity,
} from "./types";

const RUN_COOLDOWN_MS = 60_000;
const STALE_RUN_MS = 15 * 60_000;
const STALE_DATA_HOURS = 36;

function pick<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new HttpError(400, `${field} is invalid.`);
  }
  return value as T;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new HttpError(400, "Pagination value is invalid.");
  return parsed;
}

const insightInclude = {
  variant: { select: { sku: true, template: { select: { name: true, category: { select: { name: true } } } } } },
  lotItem: { select: { expirationDate: true, lot: { select: { lotNumber: true } } } },
} satisfies Prisma.AiInsightInclude;

export class AiInsightsService {
  async getSettings(businessId: string): Promise<InsightSettings> {
    const row = await prisma.aiInsightSettings.findUnique({ where: { businessId } });
    if (!row) return DEFAULT_SETTINGS;
    try {
      return resolveSettings(row.settings);
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  async updateSettings(businessId: string, userId: string, input: unknown) {
    const settings = resolveSettings(input, DEFAULT_SETTINGS);
    await prisma.aiInsightSettings.upsert({
      where: { businessId },
      create: { businessId, settings: settings as unknown as Prisma.InputJsonValue, updatedBy: userId },
      update: { settings: settings as unknown as Prisma.InputJsonValue, updatedBy: userId, updatedAt: new Date() },
    });
    return settings;
  }

  async list(businessId: string, query: Record<string, unknown>) {
    const type = pick<InsightType>(query.type, INSIGHT_TYPES, "type");
    const severity = pick<Severity>(query.severity, SEVERITIES, "severity");
    const status = pick<InsightStatus>(query.status, INSIGHT_STATUSES, "status");
    const page = positiveInt(query.page, 1, 100_000);
    const pageSize = positiveInt(query.pageSize, 25, 100);

    const where: Prisma.AiInsightWhereInput = {
      businessId,
      ...(type ? { type } : {}),
      ...(severity ? { severity } : {}),
      status: status ?? { in: ["OPEN", "ACKNOWLEDGED"] },
    };

    const [total, rows] = await Promise.all([
      prisma.aiInsight.count({ where }),
      prisma.aiInsight.findMany({
        where,
        include: insightInclude,
        orderBy: [{ priorityScore: "desc" }, { lastDetectedAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { page, pageSize, total, items: rows.map(presentInsight) };
  }

  async get(businessId: string, id: string) {
    const row = await prisma.aiInsight.findFirst({ where: { id, businessId }, include: insightInclude });
    if (!row) throw new HttpError(404, "Insight not found.");
    return presentInsight(row);
  }

  async summary(businessId: string) {
    const [groups, latestRun] = await Promise.all([
      prisma.aiInsight.groupBy({
        by: ["type", "severity"],
        where: { businessId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        _count: { _all: true },
        _sum: { valueAtRisk: true },
      }),
      prisma.aiInsightRun.findFirst({ where: { businessId }, orderBy: { startedAt: "desc" } }),
    ]);

    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let valueAtRisk = 0;
    for (const group of groups) {
      byType[group.type] = (byType[group.type] ?? 0) + group._count._all;
      bySeverity[group.severity] = (bySeverity[group.severity] ?? 0) + group._count._all;
      valueAtRisk += Number(group._sum.valueAtRisk ?? 0);
    }

    const lastSuccess =
      latestRun?.status === "SUCCEEDED"
        ? latestRun
        : await prisma.aiInsightRun.findFirst({
            where: { businessId, status: "SUCCEEDED" },
            orderBy: { startedAt: "desc" },
          });
    const stale =
      !lastSuccess?.finishedAt || Date.now() - lastSuccess.finishedAt.getTime() > STALE_DATA_HOURS * 3_600_000;

    return {
      byType,
      bySeverity,
      totalActive: Object.values(byType).reduce((a, b) => a + b, 0),
      valueAtRisk,
      stale,
      latestRun: latestRun && {
        id: latestRun.id,
        status: latestRun.status,
        triggerType: latestRun.triggerType,
        dataAsOf: latestRun.dataAsOf.toISOString().slice(0, 10),
        startedAt: latestRun.startedAt,
        finishedAt: latestRun.finishedAt,
        error: latestRun.error,
      },
      capital: (lastSuccess?.summary as { capital?: unknown } | null)?.capital ?? null,
      warnings: lastSuccess?.warnings ?? [],
    };
  }

  async updateInsight(businessId: string, id: string, userId: string, body: Record<string, unknown>) {
    const status = pick(body.status, ["OPEN", "ACKNOWLEDGED", "DISMISSED"] as const, "status");
    if (!status) throw new HttpError(400, "status is required.");

    let snoozeUntil: Date | null = null;
    if (status === "DISMISSED" && body.snoozeDays !== undefined && body.snoozeDays !== null) {
      const days = Number(body.snoozeDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, "snoozeDays must be between 1 and 365.");
      snoozeUntil = new Date(`${addDays(await businessToday(), days)}T00:00:00.000Z`);
    }

    const result = await prisma.aiInsight.updateMany({
      where: { id, businessId, status: { not: "RESOLVED" } },
      data: { status, snoozeUntil, handledBy: userId, handledAt: new Date() },
    });
    if (result.count === 0) throw new HttpError(404, "Insight not found or already resolved.");
    return this.get(businessId, id);
  }

  async run(businessId: string, triggerType: "MANUAL" | "SCHEDULED", userId: string | null) {
    const recent = await prisma.aiInsightRun.findFirst({ where: { businessId }, orderBy: { startedAt: "desc" } });
    if (recent) {
      const age = Date.now() - recent.startedAt.getTime();
      if (recent.status === "RUNNING" && age < STALE_RUN_MS) throw new HttpError(409, "An analysis is already running.");
      if (triggerType === "MANUAL" && age < RUN_COOLDOWN_MS) throw new HttpError(429, "Please wait a minute before analyzing again.");
    }

    const today = await businessToday();
    const asOf = addDays(today, -1);
    const run = await prisma.aiInsightRun.create({
      data: {
        businessId,
        triggerType,
        status: "RUNNING",
        dataAsOf: new Date(`${asOf}T00:00:00.000Z`),
        triggeredBy: userId,
      },
    });

    try {
      const settings = await this.getSettings(businessId);
      await businessDataService.rebuildPosMetrics(businessId, windowStart(asOf), asOf);
      const snapshot = await buildSnapshot(businessId, today);
      const analysis = analyze(snapshot, settings);
      const outcome = await this.persist(businessId, run.id, analysis.findings, today);

      const summary = {
        variantsAnalyzed: analysis.variantsAnalyzed,
        findings: analysis.findings.length,
        ...outcome,
        capital: analysis.capital,
        settings,
      };
      await prisma.aiInsightRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          summary: summary as unknown as Prisma.InputJsonValue,
          warnings: analysis.warnings as unknown as Prisma.InputJsonValue,
        },
      });
      return { runId: run.id, ...summary, warnings: analysis.warnings };
    } catch (error) {
      await prisma.aiInsightRun.update({
        where: { id: run.id },
        data: { status: "FAILED", finishedAt: new Date(), error: error instanceof Error ? error.message.slice(0, 1000) : "Unknown error" },
      });
      throw error;
    }
  }

  private async persist(
    businessId: string,
    runId: string,
    findings: ReturnType<typeof analyze>["findings"],
    today: string,
  ) {
    return prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtext(${businessId}), hashtext('ai-insights-persist')) IS NULL AS "locked"
        `;
        const existing = await tx.aiInsight.findMany({ where: { businessId } });
        const byFingerprint = new Map(existing.map((row) => [row.fingerprint, row]));
        const seen = new Set<string>();
        const now = new Date();
        let created = 0;
        let updated = 0;
        let reopened = 0;

        const toCreate: Prisma.AiInsightCreateManyInput[] = [];
        for (const finding of findings) {
          seen.add(finding.fingerprint);
          const common = {
            severity: finding.severity,
            reasonCode: finding.reasonCode,
            suggestedAction: finding.suggestedAction,
            metrics: finding.metrics as Prisma.InputJsonValue,
            valueAtRisk: finding.valueAtRisk,
            priorityScore: finding.priorityScore,
            lastDetectedAt: now,
            runId,
          };
          const current = byFingerprint.get(finding.fingerprint);
          if (!current) {
            toCreate.push({
              businessId,
              type: finding.type,
              fingerprint: finding.fingerprint,
              variantId: finding.variantId,
              lotItemId: finding.lotItemId,
              ...common,
            });
            created += 1;
            continue;
          }
          const status = nextStatus(current, finding.severity, today);
          const reopening = status === "OPEN" && current.status !== "OPEN";
          if (reopening) reopened += 1;
          updated += 1;
          await tx.aiInsight.update({
            where: { id: current.id },
            data: {
              ...common,
              status,
              resolvedAt: null,
              ...(reopening ? { snoozeUntil: null, handledBy: null, handledAt: null } : {}),
            },
          });
        }
        if (toCreate.length) await tx.aiInsight.createMany({ data: toCreate });

        const staleIds = existing.filter((row) => !seen.has(row.fingerprint) && row.status !== "RESOLVED").map((row) => row.id);
        if (staleIds.length) {
          await tx.aiInsight.updateMany({ where: { id: { in: staleIds } }, data: { status: "RESOLVED", resolvedAt: now } });
        }
        return { created, updated, reopened, resolved: staleIds.length };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }
}

type InsightRow = Prisma.AiInsightGetPayload<{ include: typeof insightInclude }>;

function presentInsight(row: InsightRow) {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    status: row.status,
    reasonCode: row.reasonCode,
    suggestedAction: row.suggestedAction,
    metrics: row.metrics,
    valueAtRisk: row.valueAtRisk === null ? null : Number(row.valueAtRisk),
    priorityScore: row.priorityScore,
    snoozeUntil: row.snoozeUntil ? row.snoozeUntil.toISOString().slice(0, 10) : null,
    firstDetectedAt: row.firstDetectedAt,
    lastDetectedAt: row.lastDetectedAt,
    variantId: row.variantId,
    sku: row.variant.sku,
    productName: row.variant.template?.name ?? row.variant.sku,
    category: row.variant.template?.category?.name ?? null,
    lotItemId: row.lotItemId,
    lotNumber: row.lotItem?.lot.lotNumber ?? null,
    expirationDate: row.lotItem?.expirationDate.toISOString().slice(0, 10) ?? null,
  };
}

export const aiInsightsService = new AiInsightsService();

/** Scheduled analysis for every business that has products; one failing business does not stop the others. */
export async function runScheduledInsights() {
  const businesses = await prisma.productVariant.findMany({ distinct: ["businessId"], select: { businessId: true } });
  let succeeded = 0;
  let failed = 0;
  for (const { businessId } of businesses) {
    try {
      await aiInsightsService.run(businessId, "SCHEDULED", null);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      console.error(`AI insight run failed for business ${businessId}.`, error);
    }
  }
  console.log(`AI insight job finished: ${succeeded} succeeded, ${failed} failed.`);
  return { succeeded, failed };
}
