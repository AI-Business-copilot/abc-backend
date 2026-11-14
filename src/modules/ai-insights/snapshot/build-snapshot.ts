import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { SALES_WINDOW_DAYS, type LotSnapshot, type Snapshot, type VariantSnapshot } from "../types";

export const TIMEZONE = "Asia/Ho_Chi_Minh";

export function addDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export async function businessToday(): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ today: string }>>`
    SELECT ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::text AS "today"
  `;
  return rows[0].today;
}

export function windowStart(asOf: string): string {
  return addDays(asOf, -(SALES_WINDOW_DAYS - 1));
}

const sumLast = (values: number[], days: number) => values.slice(values.length - days).reduce((a, b) => a + b, 0);

/** Reads inventory, lots and POS sales once per business and shapes them into per-variant facts for the rules. */
export async function buildSnapshot(businessId: string, today: string): Promise<Snapshot> {
  const asOf = addDays(today, -1);
  const from = windowStart(asOf);

  const [variants, stocks, lots, sales, lastSales] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        id: string;
        sku: string;
        name: string;
        category: string | null;
        costPrice: number;
        leadTimeDays: number;
        safetyStockQty: number;
        ageDays: number | null;
      }>
    >`
      SELECT pv."id", pv."sku", pt."name", c."name" AS "category",
             pv."cost_price"::float8 AS "costPrice",
             pv."lead_time_days" AS "leadTimeDays",
             pv."safety_stock_qty" AS "safetyStockQty",
             (${today}::date - (pv."created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int AS "ageDays"
      FROM "product_variants" pv
      JOIN "product_templates" pt ON pt."id" = pv."template_id" AND pt."business_id" = pv."business_id"
      LEFT JOIN "categories" c ON c."id" = pt."category_id"
      WHERE pv."business_id" = ${businessId}::uuid
        AND COALESCE(pv."is_active", TRUE) AND COALESCE(pt."is_active", TRUE)
    `,
    prisma.$queryRaw<Array<{ variantId: string; qty: number; recentStockout: boolean }>>`
      SELECT ib."variant_id" AS "variantId",
             COALESCE(SUM(GREATEST(ib."quantity_on_hand" - ib."damaged_quantity", 0)) FILTER (
               WHERE ib."lot_item_id" IS NULL
                  OR (li."status" IN ('HEALTHY', 'WARNING') AND li."expiration_date" >= ${today}::date)
             ), 0)::int AS "qty",
             COALESCE(BOOL_OR(ib."out_of_stock_since" >= NOW() - INTERVAL '30 days'), FALSE) AS "recentStockout"
      FROM "inventory_balances" ib
      LEFT JOIN "product_lot_items" li ON li."id" = ib."lot_item_id"
      WHERE ib."business_id" = ${businessId}::uuid
      GROUP BY ib."variant_id"
    `,
    prisma.$queryRaw<
      Array<{
        variantId: string;
        lotItemId: string;
        lotNumber: string;
        expirationDate: string;
        alertDaysBefore: number | null;
        status: string;
        qty: number;
      }>
    >`
      SELECT ib."variant_id" AS "variantId", li."id" AS "lotItemId", pl."lot_number" AS "lotNumber",
             (li."expiration_date")::text AS "expirationDate", li."alert_days_before" AS "alertDaysBefore",
             li."status", SUM(GREATEST(ib."quantity_on_hand" - ib."damaged_quantity", 0))::int AS "qty"
      FROM "inventory_balances" ib
      JOIN "product_lot_items" li ON li."id" = ib."lot_item_id"
      JOIN "product_lots" pl ON pl."id" = li."lot_id"
      WHERE ib."business_id" = ${businessId}::uuid AND li."status" IN ('HEALTHY', 'WARNING', 'UNUSABLE')
      GROUP BY ib."variant_id", li."id", pl."lot_number", li."expiration_date", li."alert_days_before", li."status"
      HAVING SUM(GREATEST(ib."quantity_on_hand" - ib."damaged_quantity", 0)) > 0
    `,
    prisma.$queryRaw<Array<{ variantId: string; day: string; units: number }>>`
      SELECT "variant_id" AS "variantId", ("metric_date")::text AS "day",
             GREATEST("units_sold" - "units_returned", 0)::int AS "units"
      FROM "channel_daily_product_metrics"
      WHERE "business_id" = ${businessId}::uuid AND "channel" = 'POS'
        AND "metric_date" BETWEEN ${from}::date AND ${asOf}::date
    `,
    prisma.$queryRaw<Array<{ variantId: string; lastSale: string }>>`
      SELECT "variant_id" AS "variantId", (MAX("metric_date"))::text AS "lastSale"
      FROM "channel_daily_product_metrics"
      WHERE "business_id" = ${businessId}::uuid AND "channel" = 'POS' AND "units_sold" > 0
        AND "metric_date" <= ${asOf}::date
      GROUP BY "variant_id"
    `,
  ]);

  const stockById = new Map(stocks.map((row) => [row.variantId, row]));
  const lastSaleById = new Map(lastSales.map((row) => [row.variantId, row.lastSale]));

  const lotsById = new Map<string, LotSnapshot[]>();
  for (const lot of lots) {
    const list = lotsById.get(lot.variantId) ?? [];
    list.push({
      lotItemId: lot.lotItemId,
      lotNumber: lot.lotNumber,
      expirationDate: lot.expirationDate,
      quantity: lot.qty,
      alertDaysBefore: lot.alertDaysBefore ?? 30,
      status: lot.status,
    });
    lotsById.set(lot.variantId, list);
  }

  const salesById = new Map<string, number[]>();
  for (const row of sales) {
    const series = salesById.get(row.variantId) ?? new Array<number>(SALES_WINDOW_DAYS).fill(0);
    const index = daysBetween(from, row.day);
    if (index >= 0 && index < SALES_WINDOW_DAYS) series[index] += row.units;
    salesById.set(row.variantId, series);
  }

  return {
    asOf,
    today,
    variants: variants.map((row): VariantSnapshot => {
      const dailySales = salesById.get(row.id) ?? new Array<number>(SALES_WINDOW_DAYS).fill(0);
      const ageDays = Math.max(0, row.ageDays ?? 365);
      const sold30 = sumLast(dailySales, 30);
      const lastSale = lastSaleById.get(row.id);
      const stock = stockById.get(row.id);
      return {
        variantId: row.id,
        sku: row.sku,
        name: row.name,
        category: row.category,
        costPrice: row.costPrice,
        leadTimeDays: row.leadTimeDays,
        safetyStockQty: row.safetyStockQty,
        stockAvailable: stock?.qty ?? 0,
        ageDays,
        dailySales,
        sold7: sumLast(dailySales, 7),
        sold14: sumLast(dailySales, 14),
        sold30,
        sold60: sumLast(dailySales, 60),
        avgDaily30: sold30 / Math.min(30, Math.max(1, ageDays)),
        daysSinceLastSale: lastSale ? daysBetween(lastSale, today) : null,
        possibleStockoutBias: stock?.recentStockout ?? false,
        lots: (lotsById.get(row.id) ?? []).sort((a, b) => a.expirationDate.localeCompare(b.expirationDate)),
      };
    }),
  };
}
