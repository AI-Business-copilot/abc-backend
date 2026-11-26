import { Prisma } from "@prisma/client";

import { dateRange, metricDate } from "../../shared/dates/date-range";
import { HttpError } from "../../shared/http/http-error";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { businessDataService, buildPosMetricRows } from "./business-data.service";

type MetricRow = ReturnType<typeof buildPosMetricRows>[number];
type Variant = { id: string; sku: string; templateId: string; template: { name: string } };
type Amounts = {
  unitsSold: number;
  unitsReturned: number;
  grossSales: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  refundAmount: Prisma.Decimal;
  netRevenue: Prisma.Decimal;
  netCogs: Prisma.Decimal;
};

const emptyAmounts = (): Amounts => ({
  unitsSold: 0, unitsReturned: 0,
  grossSales: new Prisma.Decimal(0), discountAmount: new Prisma.Decimal(0),
  refundAmount: new Prisma.Decimal(0), netRevenue: new Prisma.Decimal(0), netCogs: new Prisma.Decimal(0),
});

function add(target: Amounts, row: MetricRow) {
  target.unitsSold += row.unitsSold;
  target.unitsReturned += row.unitsReturned;
  target.grossSales = target.grossSales.plus(row.grossSales);
  target.discountAmount = target.discountAmount.plus(row.discountAmount);
  target.refundAmount = target.refundAmount.plus(row.refundAmount);
  target.netRevenue = target.netRevenue.plus(row.netRevenue);
  target.netCogs = target.netCogs.plus(row.netCogs);
}

function serialize(amounts: Amounts) {
  const profit = amounts.netRevenue.minus(amounts.netCogs);
  return {
    unitsSold: amounts.unitsSold,
    unitsReturned: amounts.unitsReturned,
    grossSales: amounts.grossSales.toFixed(2),
    discountAmount: amounts.discountAmount.toFixed(2),
    refundAmount: amounts.refundAmount.toFixed(2),
    netRevenue: amounts.netRevenue.toFixed(2),
    netCogs: amounts.netCogs.toFixed(2),
    grossProfit: profit.toFixed(2),
    marginPercent: amounts.netRevenue.gt(0) ? profit.mul(100).div(amounts.netRevenue).toFixed(2) : null,
  };
}

function comparison(current: Amounts, previous: Amounts) {
  const value = (a: Prisma.Decimal, b: Prisma.Decimal) => ({
    difference: a.minus(b).toFixed(2),
    percent: b.gt(0) ? a.minus(b).mul(100).div(b).toFixed(2) : null,
  });
  return {
    current: serialize(current),
    previous: serialize(previous),
    changes: {
      unitsSold: value(new Prisma.Decimal(current.unitsSold), new Prisma.Decimal(previous.unitsSold)),
      unitsReturned: value(new Prisma.Decimal(current.unitsReturned), new Prisma.Decimal(previous.unitsReturned)),
      netRevenue: value(current.netRevenue, previous.netRevenue),
      grossProfit: value(current.netRevenue.minus(current.netCogs), previous.netRevenue.minus(previous.netCogs)),
    },
  };
}

export function performanceRanges(from: unknown, to: unknown) {
  const current = dateRange(from, to);
  if (current.dayCount > 183) throw new HttpError(400, "The period cannot exceed 183 days.");
  const end = metricDate(current.from);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - current.dayCount + 1);
  return {
    current,
    previous: { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10), dayCount: current.dayCount },
  };
}

export function buildPerformance(rows: MetricRow[], variants: Variant[], currentFrom: string) {
  const byVariant = new Map(variants.map((variant) => [variant.id, variant]));
  const products = new Map<string, {
    id: string; name: string; current: Amounts; previous: Amounts;
    variants: Map<string, { id: string; sku: string; current: Amounts; previous: Amounts }>;
  }>();
  const totals = { current: emptyAmounts(), previous: emptyAmounts() };
  for (const row of rows) {
    const variant = byVariant.get(row.variantId);
    if (!variant) throw new Error("POS metric refers to an unavailable product in this business.");
    let product = products.get(variant.templateId);
    if (!product) {
      product = { id: variant.templateId, name: variant.template.name, current: emptyAmounts(), previous: emptyAmounts(), variants: new Map() };
      products.set(product.id, product);
    }
    let item = product.variants.get(variant.id);
    if (!item) {
      item = { id: variant.id, sku: variant.sku, current: emptyAmounts(), previous: emptyAmounts() };
      product.variants.set(item.id, item);
    }
    const period = row.metricDate.toISOString().slice(0, 10) >= currentFrom ? "current" : "previous";
    add(item[period], row);
    add(product[period], row);
    add(totals[period], row);
  }
  return {
    totals: comparison(totals.current, totals.previous),
    products: [...products.values()].map((product) => ({
      id: product.id,
      name: product.name,
      ...comparison(product.current, product.previous),
      variants: [...product.variants.values()].map((variant) => ({
        id: variant.id, sku: variant.sku, ...comparison(variant.current, variant.previous),
      })).sort((a, b) => a.sku.localeCompare(b.sku, "vi") || a.id.localeCompare(b.id)),
    })),
  };
}

function positiveInt(value: unknown, fallback: number, max: number, name: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw new HttpError(400, `Invalid ${name}.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > max) throw new HttpError(400, `Invalid ${name}.`);
  return result;
}

export async function getProductPerformance(businessId: string, query: Record<string, unknown>) {
  const ranges = performanceRanges(query.from, query.to);
  if (query.all !== undefined && query.all !== "true") throw new HttpError(400, "Invalid all.");
  const all = query.all === "true";
  const page = positiveInt(query.page, 1, 100000, "page");
  const pageSize = positiveInt(query.pageSize, 10, 50, "pageSize");
  if (query.search !== undefined && (typeof query.search !== "string" || query.search.length > 100)) throw new HttpError(400, "Invalid search.");
  const search = typeof query.search === "string" ? query.search.trim().toLocaleLowerCase("vi") : "";
  const sort = query.sort === undefined ? "revenue" : query.sort;
  if (sort !== "revenue" && sort !== "profit" && sort !== "units") throw new HttpError(400, "Invalid sort.");

  return prisma.$transaction(async (tx) => {
    const source = await businessDataService.readPosSource(tx, businessId, ranges.previous.from, ranges.current.to);
    const [variants, missingCostLinks, timestamps] = await Promise.all([
      tx.productVariant.findMany({
        where: { businessId, id: { in: [...new Set(source.rows.map((row) => row.variantId))] }, template: { businessId } },
        select: { id: true, sku: true, templateId: true, template: { select: { name: true } } },
      }),
      tx.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS "count"
        FROM customer_returns r
        JOIN customer_return_items ri ON ri.return_id = r.id
        JOIN product_variants v ON v.id = ri.variant_id AND v.business_id = r.business_id
        LEFT JOIN order_items oi ON oi.id = ri.order_item_id AND oi.variant_id = ri.variant_id
        LEFT JOIN orders o ON o.id = oi.order_id AND o.business_id = r.business_id AND o.status = 'COMPLETED'
        WHERE r.business_id = ${businessId}::uuid AND r.status = 'COMPLETED'
          AND r.created_at >= ${new Date(`${ranges.previous.from}T00:00:00+07:00`)}
          AND r.created_at < ${new Date(metricDate(ranges.current.to).getTime() + 86400000 - 7 * 3600000)}
          AND ri.item_condition = 'RESTOCKABLE' AND o.id IS NULL
      `,
      tx.$queryRaw<{ at: Date }[]>`SELECT transaction_timestamp() AS "at"`,
    ]);
    if (!timestamps[0] || !missingCostLinks[0]) throw new Error("Unable to read POS analysis metadata.");
    const result = buildPerformance(source.rows, variants, ranges.current.from);
    const filtered = result.products.filter((item) => !search || item.name.toLocaleLowerCase("vi").includes(search) || item.variants.some((v) => v.sku.toLocaleLowerCase("vi").includes(search)));
    filtered.sort((a, b) => {
      const aValue = sort === "units" ? new Prisma.Decimal(a.current.unitsSold) : new Prisma.Decimal(sort === "profit" ? a.current.grossProfit : a.current.netRevenue);
      const bValue = sort === "units" ? new Prisma.Decimal(b.current.unitsSold) : new Prisma.Decimal(sort === "profit" ? b.current.grossProfit : b.current.netRevenue);
      return bValue.comparedTo(aValue) || a.name.localeCompare(b.name, "vi") || a.id.localeCompare(b.id);
    });
    return {
      ranges,
      asOf: timestamps[0].at,
      totals: result.totals,
      warnings: {
        excludedSaleItems: source.sourceAnomalies.invalidSaleItems,
        excludedReturnItems: source.sourceAnomalies.invalidReturnItems,
        missingReturnCostLinks: missingCostLinks[0].count,
      },
      hasSyntheticSku: result.products.some((product) => product.variants.some((variant) => variant.sku.startsWith("DEMO-"))),
      items: all ? filtered : filtered.slice((page - 1) * pageSize, page * pageSize),
      pagination: all
        ? { page: 1, pageSize: filtered.length, total: filtered.length, totalPages: 1 }
        : { page, pageSize, total: filtered.length, totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)) },
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
}
