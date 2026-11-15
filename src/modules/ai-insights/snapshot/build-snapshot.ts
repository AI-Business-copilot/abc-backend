import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { resolveSupply, type LeadTimeHistory, type SupplierOption } from "../../ai-forecast/supply";
import {
  SALES_WINDOW_DAYS,
  type IncomingSupply,
  type LotSnapshot,
  type Snapshot,
  type VariantSnapshot,
} from "../types";

function mostReceipts(history: Map<string, LeadTimeHistory> | undefined): LeadTimeHistory | null {
  if (!history) return null;
  let best: LeadTimeHistory | null = null;
  for (const entry of history.values()) if (!best || entry.receipts > best.receipts) best = entry;
  return best;
}

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

/** Walks the ledger backwards from current on-hand to get end-of-day stock; days closing at <= 0 are stockout days. */
export function computeStockoutDays(currentOnHand: number, dailyChange: number[]): boolean[] {
  const flags = new Array<boolean>(dailyChange.length).fill(false);
  let closing = currentOnHand;
  for (let i = dailyChange.length - 1; i >= 0; i--) {
    flags[i] = closing <= 0;
    closing -= dailyChange[i];
  }
  return flags;
}

/** Average daily demand over the last `days`, skipping stockout days; falls back to the raw mean with too few clean days. */
export function uncensoredAverage(sales: number[], stockoutDays: boolean[], days: number, ageDays: number): number {
  const start = sales.length - days;
  let sum = 0;
  let clean = 0;
  for (let i = start; i < sales.length; i++) {
    if (stockoutDays[i]) continue;
    sum += sales[i];
    clean++;
  }
  const window = Math.min(days, Math.max(1, ageDays));
  if (clean < Math.min(7, window)) return sumLast(sales, days) / window;
  return sum / Math.min(clean, window);
}

/** Reads inventory, lots and POS sales once per business and shapes them into per-variant facts for the rules. */
export async function buildSnapshot(businessId: string, today: string): Promise<Snapshot> {
  const asOf = addDays(today, -1);
  const from = windowStart(asOf);

  const [variants, stocks, lots, sales, lastSales, ledgerDays, onHandRows, supplierRows, historyRows, incomingRows] =
    await Promise.all([
    prisma.$queryRaw<
      Array<{
        id: string;
        sku: string;
        name: string;
        category: string | null;
        costPrice: number;
        basePrice: number;
        leadTimeDays: number;
        reviewPeriodDays: number;
        minOrderQty: number;
        packSize: number;
        safetyStockQty: number;
        ageDays: number | null;
      }>
    >`
      SELECT pv."id", pv."sku", pt."name", c."name" AS "category",
             pv."cost_price"::float8 AS "costPrice",
             pv."base_price"::float8 AS "basePrice",
             pv."lead_time_days" AS "leadTimeDays",
             pv."review_period_days" AS "reviewPeriodDays",
             pv."min_order_qty" AS "minOrderQty",
             pv."pack_size" AS "packSize",
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
    prisma.$queryRaw<Array<{ variantId: string; day: string; units: number; grossUnits: number }>>`
      SELECT "variant_id" AS "variantId", ("metric_date")::text AS "day",
             GREATEST("units_sold" - "units_returned", 0)::int AS "units",
             "units_sold"::int AS "grossUnits"
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
    prisma.$queryRaw<Array<{ variantId: string; day: string; change: number }>>`
      SELECT "variant_id" AS "variantId", (("created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::text AS "day",
             SUM("quantity_changed")::int AS "change"
      FROM "inventory_ledger"
      WHERE "business_id" = ${businessId}::uuid
        AND ("created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= ${from}::date
      GROUP BY 1, 2
    `,
    prisma.$queryRaw<Array<{ variantId: string; onHand: number }>>`
      SELECT "variant_id" AS "variantId", COALESCE(SUM("quantity_on_hand"), 0)::int AS "onHand"
      FROM "inventory_balances"
      WHERE "business_id" = ${businessId}::uuid
      GROUP BY "variant_id"
    `,
    prisma.$queryRaw<
      Array<{
        variantId: string;
        supplierId: string;
        supplierName: string;
        supplyPrice: number;
        minOrderQty: number;
        orderMultiple: number;
        leadTimeDays: number | null;
        isPreferred: boolean;
      }>
    >`
      SELECT sp."variant_id" AS "variantId", sp."supplier_id" AS "supplierId", s."name" AS "supplierName",
             sp."supply_price"::float8 AS "supplyPrice", sp."min_order_qty" AS "minOrderQty",
             sp."order_multiple" AS "orderMultiple", sp."lead_time_days" AS "leadTimeDays",
             sp."is_preferred" AS "isPreferred"
      FROM "supplier_products" sp
      JOIN "suppliers" s ON s."id" = sp."supplier_id"
      WHERE sp."business_id" = ${businessId}::uuid AND sp."is_active" AND COALESCE(s."is_active", TRUE)
    `,
    prisma.$queryRaw<Array<{ variantId: string; supplierId: string; medianDays: number; receipts: number }>>`
      SELECT pri."variant_id" AS "variantId", po."supplier_id" AS "supplierId",
             (PERCENTILE_CONT(0.5) WITHIN GROUP (
               ORDER BY ((pr."received_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - po."order_date")
             ))::float8 AS "medianDays",
             COUNT(DISTINCT pr."id")::int AS "receipts"
      FROM "purchase_receipt_items" pri
      JOIN "purchase_receipts" pr ON pr."id" = pri."receipt_id" AND pr."status" = 'RECEIVED'
      JOIN "purchase_orders" po ON po."id" = pr."po_id"
      WHERE pr."business_id" = ${businessId}::uuid AND pr."received_at" >= NOW() - INTERVAL '180 days'
      GROUP BY pri."variant_id", po."supplier_id"
    `,
    prisma.$queryRaw<
      Array<{ variantId: string; poId: string; poCode: string; qty: number; expected: string | null; orderDate: string }>
    >`
      SELECT poi."variant_id" AS "variantId", po."id" AS "poId", po."po_code" AS "poCode",
             (poi."ordered_qty" - poi."received_qty")::int AS "qty",
             (po."expected_delivery_date")::text AS "expected", (po."order_date")::text AS "orderDate"
      FROM "purchase_order_items" poi
      JOIN "purchase_orders" po ON po."id" = poi."po_id"
      WHERE po."business_id" = ${businessId}::uuid
        AND po."status" IN ('ORDERED', 'PARTIALLY_RECEIVED')
        AND poi."ordered_qty" > poi."received_qty"
    `,
  ]);

  const suppliersByVariant = new Map<string, SupplierOption[]>();
  for (const row of supplierRows) {
    const list = suppliersByVariant.get(row.variantId) ?? [];
    list.push(row);
    suppliersByVariant.set(row.variantId, list);
  }
  const historyByVariant = new Map<string, Map<string, LeadTimeHistory>>();
  for (const row of historyRows) {
    const bySupplier = historyByVariant.get(row.variantId) ?? new Map<string, LeadTimeHistory>();
    bySupplier.set(row.supplierId, { medianDays: row.medianDays, receipts: row.receipts });
    historyByVariant.set(row.variantId, bySupplier);
  }
  const incomingByVariant = new Map<string, IncomingSupply[]>();
  const leadByVariant = new Map(variants.map((row) => [row.id, row.leadTimeDays]));
  for (const row of incomingRows) {
    const lead = leadByVariant.get(row.variantId) ?? 3;
    const arrivalDate = row.expected ?? addDays(row.orderDate, lead);
    const list = incomingByVariant.get(row.variantId) ?? [];
    list.push({ poId: row.poId, poCode: row.poCode, qty: row.qty, arrivalDate, overdue: arrivalDate < today });
    incomingByVariant.set(row.variantId, list);
  }

  const onHandById = new Map(onHandRows.map((row) => [row.variantId, row.onHand]));
  const changesById = new Map<string, number[]>();
  for (const row of ledgerDays) {
    const series = changesById.get(row.variantId) ?? new Array<number>(SALES_WINDOW_DAYS + 1).fill(0);
    const index = daysBetween(from, row.day);
    // The extra last slot holds today's movements, which must be undone to get yesterday's closing stock.
    if (index >= 0 && index <= SALES_WINDOW_DAYS) series[index] += row.change;
    changesById.set(row.variantId, series);
  }

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
  const grossSalesById = new Map<string, number[]>();
  for (const row of sales) {
    const series = salesById.get(row.variantId) ?? new Array<number>(SALES_WINDOW_DAYS).fill(0);
    const gross = grossSalesById.get(row.variantId) ?? new Array<number>(SALES_WINDOW_DAYS).fill(0);
    const index = daysBetween(from, row.day);
    if (index >= 0 && index < SALES_WINDOW_DAYS) {
      series[index] += row.units;
      gross[index] += row.grossUnits;
    }
    salesById.set(row.variantId, series);
    grossSalesById.set(row.variantId, gross);
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
      const changes = changesById.get(row.id) ?? new Array<number>(SALES_WINDOW_DAYS + 1).fill(0);
      const stockoutDays = computeStockoutDays(onHandById.get(row.id) ?? 0, changes).slice(0, SALES_WINDOW_DAYS);
      const recentStockout = stockoutDays.slice(-30).some(Boolean);
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
        grossDailySales: grossSalesById.get(row.id) ?? new Array<number>(SALES_WINDOW_DAYS).fill(0),
        sold7: sumLast(dailySales, 7),
        sold14: sumLast(dailySales, 14),
        sold30,
        sold60: sumLast(dailySales, 60),
        avgDaily30: uncensoredAverage(dailySales, stockoutDays, 30, ageDays),
        stockoutDays,
        daysSinceLastSale: lastSale ? daysBetween(lastSale, today) : null,
        possibleStockoutBias: recentStockout || (stock?.recentStockout ?? false),
        lots: (lotsById.get(row.id) ?? []).sort((a, b) => a.expirationDate.localeCompare(b.expirationDate)),
        basePrice: row.basePrice,
        incoming: (incomingByVariant.get(row.id) ?? []).sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate)),
        supply: resolveSupply(
          row,
          suppliersByVariant.get(row.id) ?? [],
          historyByVariant.get(row.id) ?? new Map(),
          mostReceipts(historyByVariant.get(row.id)),
        ),
      };
    }),
  };
}
