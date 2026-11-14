import { Prisma } from "@prisma/client";

import { dateRange, metricDate } from "../../shared/dates/date-range";
import { prisma } from "../../shared/infrastructure/database/prisma.client";

const VIETNAM_OFFSET = "+07:00";

type PosSalesAggregate = {
  metricDate: Date | string;
  variantId: string;
  unitsSold: number;
  orderCount: number;
  grossSales: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  cogs: Prisma.Decimal;
};

type PosReturnAggregate = {
  metricDate: Date | string;
  variantId: string;
  unitsReturned: number;
  refundAmount: Prisma.Decimal;
  returnedCogs: Prisma.Decimal;
};

type PosSourceAnomalies = {
  invalidSaleItems: number;
  invalidReturnItems: number;
  invalidReturnOrderLinks: number;
};

function nextDay(value: string): string {
  const date = metricDate(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function businessDayStart(value: string): Date {
  return new Date(`${value}T00:00:00.000${VIETNAM_OFFSET}`);
}

function metricDay(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

export function buildPosMetricRows(
  businessId: string,
  sales: PosSalesAggregate[],
  returns: PosReturnAggregate[],
) {
  const metrics = new Map<string, {
    day: string;
    variantId: string;
    unitsSold: number;
    unitsReturned: number;
    orderCount: number;
    grossSales: Prisma.Decimal;
    discountAmount: Prisma.Decimal;
    refundAmount: Prisma.Decimal;
    returnedCogs: Prisma.Decimal;
    cogs: Prisma.Decimal;
  }>();
  const getMetric = (day: string, variantId: string) => {
    const key = `${day}:${variantId}`;
    let metric = metrics.get(key);
    if (!metric) {
      metric = {
        day,
        variantId,
        unitsSold: 0,
        unitsReturned: 0,
        orderCount: 0,
        grossSales: new Prisma.Decimal(0),
        discountAmount: new Prisma.Decimal(0),
        refundAmount: new Prisma.Decimal(0),
        returnedCogs: new Prisma.Decimal(0),
        cogs: new Prisma.Decimal(0),
      };
      metrics.set(key, metric);
    }
    return metric;
  };

  for (const row of sales) {
    const metric = getMetric(metricDay(row.metricDate), row.variantId);
    metric.unitsSold += row.unitsSold;
    metric.orderCount += row.orderCount;
    metric.grossSales = metric.grossSales.plus(row.grossSales);
    metric.discountAmount = metric.discountAmount.plus(row.discountAmount);
    metric.cogs = metric.cogs.plus(row.cogs);
  }
  for (const row of returns) {
    const metric = getMetric(metricDay(row.metricDate), row.variantId);
    metric.unitsReturned += row.unitsReturned;
    metric.refundAmount = metric.refundAmount.plus(row.refundAmount);
    metric.returnedCogs = metric.returnedCogs.plus(row.returnedCogs);
  }

  return [...metrics.values()].map((metric) => ({
    businessId,
    channel: "POS",
    variantId: metric.variantId,
    metricDate: metricDate(metric.day),
    unitsSold: metric.unitsSold,
    unitsReturned: metric.unitsReturned,
    orderCount: metric.orderCount,
    grossSales: metric.grossSales,
    discountAmount: metric.discountAmount,
    refundAmount: metric.refundAmount,
    returnedCogs: metric.returnedCogs,
    netRevenue: metric.grossSales.minus(metric.discountAmount).minus(metric.refundAmount),
    netCogs: metric.cogs.minus(metric.returnedCogs),
  }));
}

export class BusinessDataService {
  async rebuildPosMetrics(businessId: string, fromValue: unknown, toValue: unknown) {
    const range = dateRange(fromValue, toValue);
    const start = businessDayStart(range.from);
    const end = businessDayStart(nextDay(range.to));
    const startDate = metricDate(range.from);
    const endDate = metricDate(nextDay(range.to));

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${businessId}), hashtext('pos-metric-rebuild')) IS NULL AS "locked"
      `;

      const [sales, returns, ordersProcessed, returnsProcessed, anomalies] = await Promise.all([
        tx.$queryRaw<PosSalesAggregate[]>`
          SELECT
            (o."created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS "metricDate",
            oi."variant_id" AS "variantId",
            SUM(oi."quantity")::int AS "unitsSold",
            COUNT(DISTINCT o."id")::int AS "orderCount",
            COALESCE(SUM(oi."subtotal"), 0)::numeric(14,2) AS "grossSales",
            COALESCE(SUM(oi."discount_amount"), 0)::numeric(14,2) AS "discountAmount",
            COALESCE(SUM(oi."unit_cost" * oi."quantity"), 0)::numeric(14,2) AS "cogs"
          FROM "orders" o
          JOIN "order_items" oi ON oi."order_id" = o."id"
          JOIN "product_variants" v
            ON v."id" = oi."variant_id" AND v."business_id" = o."business_id"
          WHERE o."business_id" = ${businessId}::uuid
            AND o."status" = 'COMPLETED'
            AND o."created_at" >= ${start}
            AND o."created_at" < ${end}
          GROUP BY "metricDate", oi."variant_id"
        `,
        tx.$queryRaw<PosReturnAggregate[]>`
          SELECT
            (r."created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS "metricDate",
            ri."variant_id" AS "variantId",
            SUM(ri."return_qty")::int AS "unitsReturned",
            COALESCE(SUM(ri."refund_amount"), 0)::numeric(14,2) AS "refundAmount",
            COALESCE(SUM(
              CASE
                WHEN ri."item_condition" = 'RESTOCKABLE' AND source_order."id" IS NOT NULL
                  THEN oi."unit_cost" * ri."return_qty"
                ELSE 0
              END
            ), 0)::numeric(14,2) AS "returnedCogs"
          FROM "customer_returns" r
          JOIN "customer_return_items" ri ON ri."return_id" = r."id"
          JOIN "product_variants" v
            ON v."id" = ri."variant_id" AND v."business_id" = r."business_id"
          LEFT JOIN "order_items" oi
            ON oi."id" = ri."order_item_id" AND oi."variant_id" = ri."variant_id"
          LEFT JOIN "orders" source_order
            ON source_order."id" = oi."order_id"
            AND source_order."business_id" = r."business_id"
            AND source_order."status" = 'COMPLETED'
          WHERE r."business_id" = ${businessId}::uuid
            AND r."status" = 'COMPLETED'
            AND r."created_at" >= ${start}
            AND r."created_at" < ${end}
          GROUP BY "metricDate", ri."variant_id"
        `,
        tx.order.count({
          where: { businessId, status: "COMPLETED", createdAt: { gte: start, lt: end } },
        }),
        tx.customerReturn.count({
          where: { businessId, status: "COMPLETED", createdAt: { gte: start, lt: end } },
        }),
        tx.$queryRaw<PosSourceAnomalies[]>`
          SELECT
            (
              SELECT COUNT(*)::int
              FROM "orders" o
              JOIN "order_items" oi ON oi."order_id" = o."id"
              LEFT JOIN "product_variants" v
                ON v."id" = oi."variant_id" AND v."business_id" = o."business_id"
              WHERE o."business_id" = ${businessId}::uuid
                AND o."status" = 'COMPLETED'
                AND o."created_at" >= ${start}
                AND o."created_at" < ${end}
                AND v."id" IS NULL
            ) AS "invalidSaleItems",
            (
              SELECT COUNT(*)::int
              FROM "customer_returns" r
              JOIN "customer_return_items" ri ON ri."return_id" = r."id"
              LEFT JOIN "product_variants" v
                ON v."id" = ri."variant_id" AND v."business_id" = r."business_id"
              WHERE r."business_id" = ${businessId}::uuid
                AND r."status" = 'COMPLETED'
                AND r."created_at" >= ${start}
                AND r."created_at" < ${end}
                AND v."id" IS NULL
            ) AS "invalidReturnItems",
            (
              SELECT COUNT(*)::int
              FROM "customer_returns" r
              JOIN "customer_return_items" ri ON ri."return_id" = r."id"
              LEFT JOIN "order_items" oi
                ON oi."id" = ri."order_item_id" AND oi."variant_id" = ri."variant_id"
              LEFT JOIN "orders" source_order
                ON source_order."id" = oi."order_id"
                AND source_order."business_id" = r."business_id"
                AND source_order."status" = 'COMPLETED'
              WHERE r."business_id" = ${businessId}::uuid
                AND r."status" = 'COMPLETED'
                AND r."created_at" >= ${start}
                AND r."created_at" < ${end}
                AND ri."order_item_id" IS NOT NULL
                AND source_order."id" IS NULL
            ) AS "invalidReturnOrderLinks"
        `,
      ]);
      const rows = buildPosMetricRows(businessId, sales, returns);
      const sourceAnomalies = anomalies[0] ?? {
        invalidSaleItems: 0,
        invalidReturnItems: 0,
        invalidReturnOrderLinks: 0,
      };

      await tx.channelDailyProductMetric.deleteMany({
        where: {
          businessId,
          channel: "POS",
          metricDate: { gte: startDate, lt: endDate },
        },
      });

      if (rows.length) await tx.channelDailyProductMetric.createMany({ data: rows });

      return {
        channel: "POS",
        from: range.from,
        to: range.to,
        daysProcessed: range.dayCount,
        ordersProcessed,
        returnsProcessed,
        productDaysWritten: rows.length,
        excludedInvalidSaleItems: sourceAnomalies.invalidSaleItems,
        excludedInvalidReturnItems: sourceAnomalies.invalidReturnItems,
        excludedReturnCostLinks: sourceAnomalies.invalidReturnOrderLinks,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
  }

  async getAiReadyData(businessId: string, fromValue: unknown, toValue: unknown) {
    const range = dateRange(fromValue, toValue);
    const from = metricDate(range.from);
    const to = metricDate(range.to);
    const pos = await prisma.channelDailyProductMetric.findMany({
      where: { businessId, channel: "POS", metricDate: { gte: from, lte: to } },
      orderBy: [{ metricDate: "asc" }, { variantId: "asc" }],
      include: {
        variant: {
          select: {
            id: true,
            sku: true,
            template: { select: { name: true, unitOfMeasure: true } },
          },
        },
      },
    });

    return {
      range,
      pos: {
        metrics: pos,
        hasMetrics: pos.length > 0,
      },
    };
  }
}

export const businessDataService = new BusinessDataService();
