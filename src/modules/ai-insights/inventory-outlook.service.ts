import { Prisma } from "@prisma/client";

import { HttpError } from "../../shared/http/http-error";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { STALE_DATA_HOURS } from "./ai-insights.service";
import { addDays } from "./snapshot/build-snapshot";
import { INSIGHT_TYPES, SEVERITIES, type Severity } from "./types";

const insightSelect = {
  id: true, variantId: true, runId: true, type: true, severity: true, status: true,
  reasonCode: true, suggestedAction: true, metrics: true, lastDetectedAt: true,
  variant: { select: { sku: true, template: { select: { name: true, category: { select: { name: true } } } } } },
  lotItem: { select: { expirationDate: true, lot: { select: { lotNumber: true } } } },
  run: { select: { dataAsOf: true, finishedAt: true } },
} satisfies Prisma.AiInsightSelect;

const suggestionSelect = {
  id: true, variantId: true, runId: true, status: true, urgency: true, confidence: true,
  suggestedQty: true, orderByDate: true, stockoutDate: true, details: true, updatedAt: true,
  variant: { select: { sku: true, template: { select: { name: true, category: { select: { name: true } } } } } },
  supplier: { select: { name: true } },
  po: { select: { poCode: true, status: true } },
} satisfies Prisma.AiReplenishmentItemSelect;

type InsightRow = Prisma.AiInsightGetPayload<{ select: typeof insightSelect }>;
type SuggestionRow = Prisma.AiReplenishmentItemGetPayload<{ select: typeof suggestionSelect }>;
type RunSource = { id: string; dataAsOf: Date; finishedAt: Date | null };
type Warning = { code: string; message: string; count?: number };

const metricKeys = [
  "stockAvailable", "avgDaily30", "leadTimeDays", "safetyStockQty", "reorderPoint",
  "shortfallToReorderPoint", "daysOfCover", "sold30", "sold60", "daysWithoutSale",
  "neverSold", "ageDays", "periodDays", "recentUnits", "previousUnits", "dropPct",
  "thresholdDays", "targetDays", "excessQty", "lotNumber", "expirationDate", "daysToExpiry",
  "lotQuantity", "alertDaysBefore", "projectedSellableQty", "atRiskQty", "lotStatus",
  "possibleStockoutBias", "rateSource", "stockoutInDays", "stockoutDate", "restockInDays",
  "gapDays", "slackDays", "model", "confidence", "onOrderQty", "dailyRate", "restockSource",
  "leadTimeSource", "lostUnits", "worstCaseOnly",
] as const;
const detailKeys = [
  "dailyRate", "forecast14", "model", "modelVersion", "datasetKind", "leadTimeDays",
  "leadTimeSource", "reviewPeriodDays", "protectionDays", "safetyStock", "safetyStockSource",
  "stockAvailable", "unsellableLotUnits", "sellableStock", "onOrder", "position",
  "reorderPoint", "target", "rawNeed", "minOrderQty", "orderMultiple", "noSupplier", "slackDays",
] as const;

function safeFields(value: Prisma.JsonValue, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const field = value[key];
    if (field === null || typeof field === "string" || typeof field === "boolean" ||
      (typeof field === "number" && Number.isFinite(field))) result[key] = field;
  }
  return result;
}

function safeWarnings(value: Prisma.JsonValue | null): Warning[] | null {
  if (!Array.isArray(value)) return null;
  const warnings: Warning[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.code !== "string" || typeof entry.message !== "string") return null;
    warnings.push({ code: entry.code, message: entry.message, ...(typeof entry.count === "number" ? { count: entry.count } : {}) });
  }
  return warnings;
}

const date = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
const source = (run: { dataAsOf: Date; finishedAt: Date | null } | undefined) => ({
  dataAsOf: run ? date(run.dataAsOf) : null,
  finishedAt: run?.finishedAt ?? null,
});

function severity(value: string): Severity {
  if (!SEVERITIES.some((item) => item === value)) throw new HttpError(500, "Invalid stored insight severity.");
  return value as Severity;
}

function positiveInt(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new HttpError(400, "Pagination value is invalid.");
  return parsed;
}

export function buildInventoryOutlook(
  insights: InsightRow[], suggestions: SuggestionRow[], sources: RunSource[],
  latest: RunSource, ruleFresh: boolean, forecastReady: boolean,
) {
  type Item = {
    variantId: string; sku: string; productName: string; category: string | null;
    priority: Severity | null;
    signals: Array<{
      id: string; type: string; severity: Severity; status: string; reasonCode: string; suggestedAction: string;
      metrics: ReturnType<typeof safeFields>; lotNumber: string | null; expirationDate: string | null;
      lastDetectedAt: Date; dataAsOf: string | null; finishedAt: Date | null; current: boolean;
    }>;
    replenishment: null | {
      id: string; status: string; urgency: Severity; confidence: string | null; suggestedQty: number;
      orderByDate: string | null; stockoutDate: string | null; supplierName: string | null;
      poCode: string | null; poStatus: string | null; details: ReturnType<typeof safeFields>;
      updatedAt: Date; dataAsOf: string | null; finishedAt: Date | null; current: boolean;
    };
  };
  const items = new Map<string, Item>();
  const runs = new Map(sources.map((run) => [run.id, run]));
  const getItem = (row: InsightRow | SuggestionRow) => {
    let item = items.get(row.variantId);
    if (!item) {
      item = {
        variantId: row.variantId, sku: row.variant.sku,
        productName: row.variant.template?.name ?? row.variant.sku,
        category: row.variant.template?.category?.name ?? null, priority: null, signals: [], replenishment: null,
      };
      items.set(row.variantId, item);
    }
    return item;
  };
  const promote = (item: Item, value: Severity) => {
    if (item.priority === null || SEVERITIES.indexOf(value) < SEVERITIES.indexOf(item.priority)) item.priority = value;
  };
  for (const row of insights) {
    const item = getItem(row);
    const level = severity(row.severity);
    const metrics = safeFields(row.metrics, metricKeys);
    const needsForecast = row.type === "STOCKOUT_RISK" || metrics.rateSource === "FORECAST";
    const current = ruleFresh && row.runId === latest.id && (!needsForecast || forecastReady);
    item.signals.push({
      id: row.id, type: row.type, severity: level, status: row.status, reasonCode: row.reasonCode,
      suggestedAction: row.suggestedAction, metrics,
      lotNumber: row.lotItem?.lot.lotNumber ?? null, expirationDate: date(row.lotItem?.expirationDate ?? null),
      lastDetectedAt: row.lastDetectedAt, ...source(row.run), current,
    });
    if (current) promote(item, level);
  }
  for (const row of suggestions) {
    const item = getItem(row);
    const level = severity(row.urgency);
    const current = row.status === "PENDING" && ruleFresh && forecastReady && row.runId === latest.id;
    item.replenishment = {
      id: row.id, status: row.status, urgency: level, confidence: row.confidence,
      suggestedQty: row.suggestedQty, orderByDate: date(row.orderByDate), stockoutDate: date(row.stockoutDate),
      supplierName: row.supplier?.name ?? null, poCode: row.po?.poCode ?? null, poStatus: row.po?.status ?? null,
      details: safeFields(row.details, detailKeys), updatedAt: row.updatedAt,
      ...source(row.runId ? runs.get(row.runId) : undefined), current,
    };
    if (current) promote(item, level);
  }
  return [...items.values()].sort((a, b) =>
    (a.priority === null ? SEVERITIES.length : SEVERITIES.indexOf(a.priority)) -
      (b.priority === null ? SEVERITIES.length : SEVERITIES.indexOf(b.priority)) ||
    a.productName.localeCompare(b.productName, "vi") || a.sku.localeCompare(b.sku, "vi") ||
    a.variantId.localeCompare(b.variantId));
}

export async function inventoryOutlook(businessId: string, query: Record<string, unknown>, options?: { variantIds?: readonly string[]; all?: boolean; includeForecastComparison?: boolean }) {
  const page = positiveInt(query.page, 1, 100_000);
  const pageSize = positiveInt(query.pageSize, 25, 100);
  const search = query.search === undefined ? "" : query.search;
  if (typeof search !== "string" || search.length > 100) throw new HttpError(400, "search is invalid.");
  const type = query.type === undefined ? "" : query.type;
  if (typeof type !== "string" || (type && ![...INSIGHT_TYPES, "REPLENISHMENT", "DRAFT_ORDER"].some((value) => value === type))) {
    throw new HttpError(400, "type is invalid.");
  }
  const priority = query.priority === undefined ? "" : query.priority;
  if (typeof priority !== "string" || (priority && !SEVERITIES.some((value) => value === priority))) {
    throw new HttpError(400, "priority is invalid.");
  }

  return prisma.$transaction(async (tx) => {
    const [{ today, now }] = await tx.$queryRaw<Array<{ today: string; now: Date }>>`
      SELECT ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::text AS "today", NOW() AS "now"
    `;
    const latest = await tx.aiInsightRun.findFirst({
      where: { businessId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: { id: true, status: true, dataAsOf: true, startedAt: true, finishedAt: true, summary: true, warnings: true },
    });
    const published = latest?.summary && typeof latest.summary === "object" && !Array.isArray(latest.summary) &&
      latest.summary.publicationVersion === 1;
    if (!latest || latest.status !== "SUCCEEDED" || !latest.finishedAt || !published) {
      return {
        state: !latest ? "NOT_RUN" : latest.status === "RUNNING" ? "RUNNING" : latest.status === "FAILED" ? "FAILED" : "INCOMPLETE",
        latestRun: latest ? { status: latest.status, dataAsOf: date(latest.dataAsOf), startedAt: latest.startedAt, finishedAt: latest.finishedAt } : null,
        page, pageSize, total: null, summary: null, items: null,
        ...(options?.includeForecastComparison ? { forecastContext: null } : {}),
      };
    }
    const summary = latest.summary;
    const syntheticFlag = summary && typeof summary === "object" && !Array.isArray(summary) ? summary.hasSyntheticSku : null;
    const forecastReady = Boolean(summary && typeof summary === "object" && !Array.isArray(summary) &&
      summary.forecastStatus === "READY" && date(latest.dataAsOf) === addDays(today, -1));
    const ruleFresh = now.getTime() - latest.finishedAt.getTime() <= STALE_DATA_HOURS * 3_600_000;
    const [insights, suggestions] = await Promise.all([
      tx.aiInsight.findMany({ where: { businessId, status: { in: ["OPEN", "ACKNOWLEDGED"] } }, select: insightSelect }),
      tx.aiReplenishmentItem.findMany({
        where: { businessId, OR: [{ status: "PENDING" }, { status: "ORDERED", po: { is: { status: "DRAFT" } } }] },
        select: suggestionSelect,
      }),
    ]);
    const runIds = [...new Set(suggestions.flatMap((item) => item.runId ? [item.runId] : []))];
    const sources = runIds.length ? await tx.aiInsightRun.findMany({
      where: { businessId, id: { in: runIds } }, select: { id: true, dataAsOf: true, finishedAt: true },
    }) : [];
    const items = buildInventoryOutlook(insights, suggestions, sources, latest, ruleFresh, forecastReady);
    const byPriority = Object.fromEntries(SEVERITIES.map((level) => [level, items.filter((item) => item.priority === level).length]));
    const needle = search.trim().toLocaleLowerCase("vi");
    const variantIds = options?.variantIds ? new Set(options.variantIds) : null;
    const filtered = items.filter((item) =>
      (!variantIds || variantIds.has(item.variantId)) &&
      (!needle || item.sku.toLocaleLowerCase("vi").includes(needle) || item.productName.toLocaleLowerCase("vi").includes(needle)) &&
      (!priority || item.priority === priority) &&
      (!type || item.signals.some((signal) => signal.type === type) ||
        (type === "REPLENISHMENT" && item.replenishment?.status === "PENDING") ||
        (type === "DRAFT_ORDER" && item.replenishment?.status === "ORDERED")));
    const actualPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
    const candidateIds = options?.includeForecastComparison
      ? filtered.filter((item) => item.signals.some((signal) => signal.type === "OVERSTOCK" && signal.current)).map((item) => item.variantId)
      : [];
    const [forecasts, sales] = candidateIds.length ? await Promise.all([
      tx.aiForecast.findMany({
        where: { businessId, variantId: { in: candidateIds } },
        select: { variantId: true, runId: true, asOf: true, status: true, model: true, confidence: true, result: true, updatedAt: true },
      }),
      tx.channelDailyProductMetric.groupBy({
        by: ["variantId"],
        where: {
          businessId, channel: "POS", variantId: { in: candidateIds },
          metricDate: { gte: new Date(`${addDays(date(latest.dataAsOf)!, -29)}T00:00:00.000Z`), lte: latest.dataAsOf },
        },
        _sum: { unitsSold: true },
      }),
    ]) : [[], []];
    return {
      state: "READY",
      latestRun: { status: latest.status, dataAsOf: date(latest.dataAsOf), startedAt: latest.startedAt, finishedAt: latest.finishedAt },
      ruleFresh, forecastReady, warnings: safeWarnings(latest.warnings),
      hasSyntheticSku: typeof syntheticFlag === "boolean"
        ? syntheticFlag || items.some((item) => item.sku.startsWith("DEMO-"))
        : items.some((item) => item.sku.startsWith("DEMO-")) ? true : null,
      summary: { totalSku: items.length, byPriority, withoutCurrentPriority: items.filter((item) => item.priority === null).length },
      page: actualPage, pageSize, total: filtered.length,
      items: options?.all ? filtered : filtered.slice((actualPage - 1) * pageSize, actualPage * pageSize),
      ...(options?.includeForecastComparison ? { forecastContext: { today, latest, forecasts, sales } } : {}),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
