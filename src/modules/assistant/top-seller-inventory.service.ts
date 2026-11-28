import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { inventoryOutlook } from "../ai-insights/inventory-outlook.service";
import { rankTopSellers, type RankingEvidence } from "./sku-analysis.service";

type LotRow = {
  variantId: string; lotItemId: string; lotNumber: string; expirationDate: string;
  status: string; alertDays: number; quantity: number; damaged: number;
};

export async function nearExpiryLots(businessId: string, ids: string[]) {
  return prisma.$transaction(async (tx) => {
    const [clock] = await tx.$queryRaw<Array<{ asOf: Date; today: string }>>`
      SELECT NOW() AS "asOf", ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::text AS "today"
    `;
    if (!clock) throw new Error("Cannot read inventory snapshot time.");
    const lots = ids.length ? await tx.$queryRaw<LotRow[]>`
      SELECT ib."variant_id" AS "variantId", li."id" AS "lotItemId", pl."lot_number" AS "lotNumber",
             li."expiration_date"::text AS "expirationDate", li."status",
             COALESCE(li."alert_days_before", 30) AS "alertDays",
             SUM(ib."quantity_on_hand")::int AS "quantity", SUM(ib."damaged_quantity")::int AS "damaged"
      FROM "inventory_balances" ib
      JOIN "product_lot_items" li ON li."id" = ib."lot_item_id" AND li."business_id" = ib."business_id" AND li."variant_id" = ib."variant_id"
      JOIN "product_lots" pl ON pl."id" = li."lot_id" AND pl."business_id" = ib."business_id"
      WHERE ib."business_id" = ${businessId}::uuid
        AND ib."variant_id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        AND li."expiration_date" >= ${clock.today}::date
        AND li."expiration_date" <= ${clock.today}::date + COALESCE(li."alert_days_before", 30)
      GROUP BY ib."variant_id", li."id", pl."lot_number"
      HAVING SUM(ib."quantity_on_hand") > 0
      ORDER BY li."expiration_date", pl."lot_number", li."id"
    ` : [];
    return { ...clock, lots };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export function matchingExpiryLots(variantId: string, lots: LotRow[]) {
  const matching = lots.filter((lot) => lot.variantId === variantId);
  return matching.length ? {
    totalLots: matching.length,
    lots: matching.slice(0, 5).map((lot) => ({
      id: lot.lotItemId, lotNumber: lot.lotNumber, expirationDate: lot.expirationDate,
      status: lot.status, quantity: lot.quantity, damaged: lot.damaged, alertDays: lot.alertDays,
    })),
  } : null;
}

export async function answerTopSellerInventory(businessId: string, kind: "top_sellers_overstock" | "top_sellers_near_expiry") {
  const ranking = await rankTopSellers(businessId);
  return answerRankedTopSellerInventory(businessId, kind, ranking);
}

export async function answerRankedTopSellerInventory(businessId: string, kind: "top_sellers_overstock" | "top_sellers_near_expiry", ranking: RankingEvidence) {
  const ids = ranking.items.map((item) => item.variantId);
  const salesPartial = Object.values(ranking.warnings).some((value) => value > 0);
  if (kind === "top_sellers_near_expiry") {
    const { asOf, today, lots } = await nearExpiryLots(businessId, ids);
    const items = ranking.items.flatMap((item) => {
      const matching = matchingExpiryLots(item.variantId, lots);
      return matching ? [{ ...item, ...matching }] : [];
    });
    const evidence = {
      type: "top_sellers_near_expiry_v1" as const, state: salesPartial ? "partial" : "ready",
      period: ranking.period, salesAsOf: ranking.salesAsOf, warnings: ranking.warnings,
      rankingCount: ranking.items.length, totalSku: items.length, inventoryAsOf: asOf.toISOString(), inventoryDay: today, items,
    };
    return { text: items.length ? `Trong ${ranking.items.length} mã bán chạy, có ${items.length} mã có lô còn tồn trong thời gian cảnh báo hạn.` :
      `Chưa tìm thấy lô còn tồn trong thời gian cảnh báo hạn của ${ranking.items.length} mã bán chạy.`, evidence };
  }
  const outlook = await inventoryOutlook(businessId, {}, { variantIds: ids, all: true });
  const available = outlook.state === "READY" && "ruleFresh" in outlook && outlook.ruleFresh === true;
  if (available && !outlook.items) throw new Error("Inventory outlook is missing current items.");
  const warningCodes = "warnings" in outlook ? outlook.warnings?.map((warning) => warning.code) ?? null : null;
  let skipped = 0;
  const items = available && outlook.items ? ranking.items.flatMap((item) => {
    const signal = outlook.items?.find((row) => row.variantId === item.variantId)?.signals.find((row) => row.current && row.type === "OVERSTOCK");
    if (!signal) return [];
    const { stockAvailable, daysOfCover, thresholdDays } = signal.metrics;
    if (typeof stockAvailable !== "number" || typeof daysOfCover !== "number" || typeof thresholdDays !== "number") {
      skipped++;
      return [];
    }
    return [{ ...item, stockAvailable, daysOfCover, thresholdDays, possibleStockoutBias: signal.metrics.possibleStockoutBias === true }];
  }) : [];
  const partial = salesPartial || skipped > 0 || warningCodes === null || warningCodes.some((code) => code === "INSUFFICIENT_HISTORY" || code === "NO_SALES_DATA");
  const evidence = {
    type: "top_sellers_overstock_v1" as const, state: !available ? "unavailable" : partial ? "partial" : "ready",
    period: ranking.period, salesAsOf: ranking.salesAsOf, warnings: ranking.warnings,
    rankingCount: ranking.items.length, totalSku: available ? items.length : null, skippedSku: available ? skipped : null,
    dataAsOf: outlook.latestRun?.dataAsOf ?? null, finishedAt: outlook.latestRun?.finishedAt?.toISOString() ?? null, warningCodes, items,
  };
  return { text: !available ? "Phân tích tồn kho chưa sẵn sàng hoặc đã cũ; chưa thể đối chiếu." :
    items.length ? `Trong ${ranking.items.length} mã bán chạy, có ${items.length} mã có cảnh báo tồn nhiều.` :
      `Chưa tìm thấy cảnh báo tồn nhiều trong ${ranking.items.length} mã bán chạy.`, evidence };
}
