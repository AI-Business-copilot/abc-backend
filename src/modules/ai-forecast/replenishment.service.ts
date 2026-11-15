import { Prisma } from "@prisma/client";

import { HttpError } from "../../shared/http/http-error";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { purchasesWriteService } from "../purchases/purchases-write.service";
import { addDays, businessToday } from "../ai-insights/snapshot/build-snapshot";
import type { Snapshot } from "../ai-insights/types";
import type { ReplenishmentSuggestion } from "./replenishment";

const URGENCY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const asDate = (value: string | null) => (value ? new Date(`${value}T00:00:00.000Z`) : null);
const isoDate = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

/** Replaces the stored latest forecast of every product. Runs inside the insight persist transaction. */
export async function persistForecasts(tx: Prisma.TransactionClient, businessId: string, runId: string, snapshot: Snapshot) {
  const rows: Prisma.AiForecastCreateManyInput[] = snapshot.variants.flatMap((v) =>
    v.forecast
      ? [
          {
            businessId,
            variantId: v.variantId,
            runId,
            asOf: new Date(`${snapshot.asOf}T00:00:00.000Z`),
            status: v.forecast.status,
            model: v.forecast.model,
            confidence: v.forecast.confidence,
            dailyRate: v.forecast.dailyRate,
            result: v.forecast as unknown as Prisma.InputJsonValue,
          },
        ]
      : [],
  );
  await tx.aiForecast.deleteMany({ where: { businessId } });
  if (rows.length) await tx.aiForecast.createMany({ data: rows });
  return rows.length;
}

/**
 * Syncs suggestions with the latest analysis. A suggestion whose draft PO is still waiting for the owner is left alone;
 * a dismissed one comes back only when its snooze ends or the urgency gets worse.
 */
export async function persistReplenishment(
  tx: Prisma.TransactionClient,
  businessId: string,
  runId: string,
  suggestions: ReplenishmentSuggestion[],
  today: string,
) {
  const existing = await tx.aiReplenishmentItem.findMany({ where: { businessId }, include: { po: { select: { status: true } } } });
  const byVariant = new Map(existing.map((row) => [row.variantId, row]));
  const waitingOnDraft = (row: (typeof existing)[number]) => row.status === "ORDERED" && row.po?.status === "DRAFT";
  const seen = new Set<string>();
  const now = new Date();
  const toCreate: Prisma.AiReplenishmentItemCreateManyInput[] = [];
  let resolved = 0;

  for (const s of suggestions) {
    seen.add(s.variantId);
    const data = {
      runId,
      supplierId: s.supplierId,
      urgency: s.urgency,
      confidence: s.confidence,
      suggestedQty: s.suggestedQty,
      unitCost: s.unitCost,
      amount: s.amount,
      orderByDate: asDate(s.orderByDate),
      stockoutDate: asDate(s.stockoutDate),
      details: s.details as Prisma.InputJsonValue,
      updatedAt: now,
    };
    const current = byVariant.get(s.variantId);
    if (!current) {
      toCreate.push({ businessId, variantId: s.variantId, status: "PENDING", ...data });
      continue;
    }
    if (waitingOnDraft(current)) continue;
    const snoozeOver = current.snoozeUntil !== null && isoDate(current.snoozeUntil)! <= today;
    const escalated = (URGENCY_RANK[s.urgency] ?? 0) > (URGENCY_RANK[current.urgency] ?? 0);
    if (current.status === "DISMISSED" && !snoozeOver && !escalated) {
      await tx.aiReplenishmentItem.update({ where: { id: current.id }, data });
      continue;
    }
    await tx.aiReplenishmentItem.update({
      where: { id: current.id },
      data: { ...data, status: "PENDING", poId: null, snoozeUntil: null, handledBy: null, handledAt: null },
    });
  }
  if (toCreate.length) await tx.aiReplenishmentItem.createMany({ data: toCreate });

  for (const row of existing) {
    if (seen.has(row.variantId) || row.status === "RESOLVED" || waitingOnDraft(row)) continue;
    await tx.aiReplenishmentItem.update({ where: { id: row.id }, data: { status: "RESOLVED", updatedAt: now } });
    resolved += 1;
  }
  return { created: toCreate.length, resolved };
}

const include = {
  variant: { select: { sku: true, template: { select: { name: true, category: { select: { name: true } } } } } },
  supplier: { select: { id: true, name: true } },
  po: { select: { id: true, poCode: true, status: true } },
} satisfies Prisma.AiReplenishmentItemInclude;

type ItemRow = Prisma.AiReplenishmentItemGetPayload<{ include: typeof include }>;

function present(row: ItemRow) {
  return {
    id: row.id,
    variantId: row.variantId,
    sku: row.variant.sku,
    productName: row.variant.template?.name ?? row.variant.sku,
    category: row.variant.template?.category?.name ?? null,
    status: row.status,
    urgency: row.urgency,
    confidence: row.confidence,
    suggestedQty: row.suggestedQty,
    unitCost: Number(row.unitCost),
    amount: Number(row.amount),
    orderByDate: isoDate(row.orderByDate),
    stockoutDate: isoDate(row.stockoutDate),
    snoozeUntil: isoDate(row.snoozeUntil),
    supplierId: row.supplier?.id ?? null,
    supplierName: row.supplier?.name ?? null,
    poId: row.po?.id ?? null,
    poCode: row.po?.poCode ?? null,
    poStatus: row.po?.status ?? null,
    details: row.details,
    updatedAt: row.updatedAt,
  };
}

const LIVE_STATUSES = ["PENDING", "ORDERED"];

async function forecastAvailability(businessId: string) {
  const [latestRun, latestForecast, today] = await Promise.all([
    prisma.aiInsightRun.findFirst({ where: { businessId }, orderBy: { startedAt: "desc" } }),
    prisma.aiForecast.findFirst({ where: { businessId }, orderBy: { asOf: "desc" }, select: { asOf: true } }),
    businessToday(),
  ]);
  const summary = latestRun?.summary as { forecastStatus?: unknown } | null | undefined;
  const ready = latestRun?.status === "SUCCEEDED" && summary?.forecastStatus === "READY" &&
    isoDate(latestRun.dataAsOf) === addDays(today, -1);
  const warnings = Array.isArray(latestRun?.warnings) ? latestRun.warnings.filter((warning) =>
    warning && typeof warning === "object" && !Array.isArray(warning) &&
    typeof warning.code === "string" && warning.code.startsWith("FORECAST_") && typeof warning.message === "string",
  ) : [];
  return { ready, runId: ready ? latestRun.id : null, asOf: latestForecast ? isoDate(latestForecast.asOf) : null, warnings };
}

export class ReplenishmentService {
  async list(businessId: string, query: Record<string, unknown>) {
    const status = typeof query.status === "string" && query.status ? query.status : null;
    if (status && !["PENDING", "ORDERED", "DISMISSED", "RESOLVED"].includes(status)) throw new HttpError(400, "status is invalid.");
    const [rows, availability] = await Promise.all([
      prisma.aiReplenishmentItem.findMany({
        where: { businessId, status: status ? status : { in: LIVE_STATUSES } },
        include,
      }),
      forecastAvailability(businessId),
    ]);
    const items = rows
      .map(present)
      .sort((a, b) => (URGENCY_RANK[b.urgency] ?? 0) - (URGENCY_RANK[a.urgency] ?? 0) || b.amount - a.amount);

    const pending = items.filter((item) => item.status === "PENDING");
    const byUrgency: Record<string, number> = {};
    for (const item of pending) byUrgency[item.urgency] = (byUrgency[item.urgency] ?? 0) + 1;
    return {
      items,
      forecastReady: availability.ready,
      forecastAsOf: availability.asOf,
      warnings: availability.warnings,
      summary: {
        pendingCount: pending.length,
        pendingAmount: pending.reduce((sum, item) => sum + item.amount, 0),
        byUrgency,
        noSupplierCount: pending.filter((item) => !item.supplierId).length,
      },
    };
  }

  async forecastDetail(businessId: string, variantId: string) {
    const [forecast, history, availability] = await Promise.all([
      prisma.aiForecast.findUnique({ where: { businessId_variantId: { businessId, variantId } } }),
      prisma.$queryRaw<Array<{ day: string; units: number }>>`
        SELECT (d.day::date)::text AS "day",
               COALESCE(m."units_sold", 0)::int AS "units"
        FROM "ai_forecasts" f
        JOIN "product_variants" v
          ON v."id" = f."variant_id" AND v."business_id" = f."business_id"
        CROSS JOIN LATERAL generate_series(
          GREATEST(f."as_of" - 55, (v."created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date),
          f."as_of",
          INTERVAL '1 day'
        ) AS d(day)
        LEFT JOIN "channel_daily_product_metrics" m
          ON m."business_id" = f."business_id" AND m."variant_id" = f."variant_id"
         AND m."channel" = 'POS' AND m."metric_date" = d.day::date
        WHERE f."business_id" = ${businessId}::uuid AND f."variant_id" = ${variantId}::uuid
        ORDER BY d.day
      `,
      forecastAvailability(businessId),
    ]);
    if (!forecast) throw new HttpError(404, "Forecast not found.");
    return {
      asOf: isoDate(forecast.asOf), status: forecast.status, forecast: forecast.result, history,
      stale: !availability.ready || forecast.runId !== availability.runId,
    };
  }

  async setStatus(businessId: string, id: string, userId: string, body: Record<string, unknown>) {
    const status = body.status;
    if (status !== "DISMISSED" && status !== "PENDING") throw new HttpError(400, "status must be DISMISSED or PENDING.");
    let snoozeUntil: Date | null = null;
    if (status === "DISMISSED" && body.snoozeDays !== undefined && body.snoozeDays !== null) {
      const days = Number(body.snoozeDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, "snoozeDays must be between 1 and 365.");
      snoozeUntil = asDate(addDays(await businessToday(), days));
    }
    const result = await prisma.aiReplenishmentItem.updateMany({
      where: { id, businessId, status: { in: ["PENDING", "DISMISSED"] } },
      data: { status, snoozeUntil, handledBy: userId, handledAt: new Date() },
    });
    if (result.count === 0) throw new HttpError(404, "Suggestion not found or already ordered.");
    const row = await prisma.aiReplenishmentItem.findUniqueOrThrow({ where: { id }, include });
    return present(row);
  }

  /** Creates one draft PO per supplier from the selected suggestions; the owner confirms each draft in Purchases. */
  async createDraftOrders(businessId: string, authUserId: string, userId: string, body: Record<string, unknown>) {
    const lines = body.items;
    if (!Array.isArray(lines) || lines.length < 1 || lines.length > 200) throw new HttpError(400, "items must contain 1-200 lines.");
    const requested = lines.map((line: Record<string, unknown>) => {
      const qty = line.qty === undefined ? null : Number(line.qty);
      if (typeof line.id !== "string") throw new HttpError(400, "Each line needs the suggestion id.");
      if (qty !== null && (!Number.isInteger(qty) || qty < 1)) throw new HttpError(400, "qty must be a positive integer.");
      return { id: line.id, qty, supplierId: typeof line.supplierId === "string" ? line.supplierId : null };
    });
    if (new Set(requested.map((r) => r.id)).size !== requested.length) throw new HttpError(400, "Duplicate suggestion in request.");

    const availability = await forecastAvailability(businessId);
    if (!availability.ready) throw new HttpError(409, "Dự báo chưa được cập nhật hoặc tạm thời không khả dụng. Hãy phân tích lại trước khi tạo đơn nháp.");
    const rows = await prisma.aiReplenishmentItem.findMany({
      where: { businessId, id: { in: requested.map((r) => r.id) }, status: "PENDING" },
      include,
    });
    if (rows.length !== requested.length || rows.some((row) => row.runId !== availability.runId)) {
      throw new HttpError(409, "Gợi ý đã cũ hoặc không còn chờ xử lý. Hãy phân tích lại và tải lại trang.");
    }

    const today = await businessToday();
    const groups = new Map<string, Array<{ row: ItemRow; qty: number; unitPrice: string; leadTime: number }>>();
    for (const request of requested) {
      const row = rows.find((r) => r.id === request.id)!;
      const supplierId = request.supplierId ?? row.supplierId;
      if (!supplierId) throw new HttpError(400, `Chưa có nhà cung cấp cho ${row.variant.sku}. Hãy chọn nhà cung cấp trước khi tạo đơn.`);
      let unitPrice = row.unitCost.toFixed(2);
      if (supplierId !== row.supplierId) {
        const offer = await prisma.supplierProduct.findFirst({ where: { businessId, supplierId, variantId: row.variantId, isActive: true } });
        if (!offer) throw new HttpError(400, `Nhà cung cấp đã chọn chưa bán ${row.variant.sku}.`);
        unitPrice = offer.supplyPrice.toFixed(2);
      }
      const details = row.details as { leadTimeDays?: number };
      const list = groups.get(supplierId) ?? [];
      list.push({ row, qty: request.qty ?? row.suggestedQty, unitPrice, leadTime: details.leadTimeDays ?? 3 });
      groups.set(supplierId, list);
    }

    const created: Array<{ id: string; poCode: string; supplierId: string; lines: number }> = [];
    for (const [supplierId, group] of groups) {
      const expected = addDays(today, Math.max(...group.map((g) => g.leadTime)));
      const order = await this.createDraftWithUniqueCode(businessId, authUserId, today, {
        supplierId,
        orderDate: today,
        expectedDeliveryDate: expected,
        items: group.map((g) => ({ variantId: g.row.variantId, orderedQty: g.qty, unitPrice: g.unitPrice })),
      });
      await prisma.aiReplenishmentItem.updateMany({
        where: { id: { in: group.map((g) => g.row.id) } },
        data: { status: "ORDERED", poId: order.id, handledBy: userId, handledAt: new Date() },
      });
      created.push({ id: order.id, poCode: order.poCode, supplierId, lines: group.length });
    }
    return { orders: created };
  }

  private async createDraftWithUniqueCode(businessId: string, authUserId: string, today: string, order: Record<string, unknown>) {
    for (let attempt = 0; ; attempt++) {
      const poCode = `AI-${today.replaceAll("-", "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      try {
        return await purchasesWriteService.createOrder(businessId, authUserId, { ...order, poCode }, "DRAFT");
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002" || attempt >= 3) throw error;
      }
    }
  }
}

export const replenishmentService = new ReplenishmentService();
