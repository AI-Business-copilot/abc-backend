import { Prisma } from "@prisma/client";

import { HttpError } from "../../shared/http/http-error";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { parseShopeeReport, type ParsedShopeeRecord } from "./shopee-report.parser";

const VIETNAM_OFFSET = "+07:00";
const MAX_RANGE_DAYS = 366;
const MAX_AI_READY_ROWS = 2_000;

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

function parseDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${field} must use YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${field} is not a valid date.`);
  }
  return value;
}

function dateRange(fromValue: unknown, toValue: unknown) {
  const from = parseDate(fromValue, "from");
  const to = parseDate(toValue, "to");
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);
  if (toDate < fromDate) throw new HttpError(400, "to must not be earlier than from.");
  const dayCount = Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
  if (dayCount > MAX_RANGE_DAYS) throw new HttpError(400, `The date range cannot exceed ${MAX_RANGE_DAYS} days.`);
  return { from, to, dayCount };
}

function metricDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

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
  async previewShopeeReport(businessId: string, buffer: Buffer) {
    const report = await parseShopeeReport(buffer);
    const existing = await prisma.onlineReportImportBatch.findUnique({
      where: {
        businessId_platform_fileHash: {
          businessId,
          platform: "SHOPEE",
          fileHash: report.fileHash,
        },
      },
      select: { id: true, createdAt: true },
    });
    return {
      platform: "SHOPEE",
      alreadyImported: Boolean(existing),
      importedAt: existing?.createdAt ?? null,
      reportFrom: report.reportFrom,
      reportTo: report.reportTo,
      sourceRowCount: report.sourceRowCount,
      uniqueRowCount: report.records.length,
      counts: report.counts,
      financeTotals: report.financeTotals,
      notes: [
        "Tài chính lấy từ các dòng Order; dòng Sku chỉ dùng nhận diện sản phẩm, không cộng lại doanh thu.",
        "Adjustment được giữ theo ngày điều chỉnh; phí dịch vụ chi tiết và chênh lệch vận chuyển chỉ dùng đối soát.",
        "Báo cáo này không cung cấp số lượng bán theo SKU nên không dùng để dự báo nhu cầu sản phẩm.",
        "Thông tin người mua và dữ liệu thanh toán cá nhân không được lưu.",
      ],
    };
  }

  async importShopeeReport(businessId: string, userId: string, buffer: Buffer) {
    const report = await parseShopeeReport(buffer);
    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.onlineReportImportBatch.findUnique({
          where: {
            businessId_platform_fileHash: {
              businessId,
              platform: "SHOPEE",
              fileHash: report.fileHash,
            },
          },
          select: { id: true, createdAt: true },
        });
        if (existing) throw new HttpError(409, "This exact Shopee report has already been imported.");

        const batch = await tx.onlineReportImportBatch.create({
          data: {
            businessId,
            importedBy: userId,
            platform: "SHOPEE",
            fileHash: report.fileHash,
            reportFrom: report.reportFrom ? metricDate(report.reportFrom) : null,
            reportTo: report.reportTo ? metricDate(report.reportTo) : null,
            sourceRowCount: report.sourceRowCount,
            importedRowCount: 0,
            summary: {
              counts: report.counts,
              financeTotals: report.financeTotals,
            },
          },
        });

        const records = report.records.map((record: ParsedShopeeRecord) => ({
          businessId,
          batchId: batch.id,
          platform: "SHOPEE",
          recordType: record.recordType,
          sourceKey: record.sourceKey,
          sourceSheet: record.sourceSheet,
          sourceRow: record.sourceRow,
          externalOrderId: record.externalOrderId,
          externalProductId: record.externalProductId,
          productName: record.productName,
          transactionDate: record.transactionDate ? metricDate(record.transactionDate) : null,
          settlementDate: record.settlementDate ? metricDate(record.settlementDate) : null,
          financialData: record.financialData ?? Prisma.DbNull,
        }));
        const inserted = records.length
          ? await tx.onlineReportRecord.createMany({ data: records, skipDuplicates: true })
          : { count: 0 };
        const updatedBatch = await tx.onlineReportImportBatch.update({
          where: { id: batch.id },
          data: { importedRowCount: inserted.count },
        });
        return {
          id: updatedBatch.id,
          reportFrom: updatedBatch.reportFrom,
          reportTo: updatedBatch.reportTo,
          sourceRowCount: updatedBatch.sourceRowCount,
          importedRowCount: updatedBatch.importedRowCount,
          skippedDuplicateRows: report.records.length - inserted.count,
          summary: updatedBatch.summary,
          createdAt: updatedBatch.createdAt,
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new HttpError(409, "This Shopee report or its source transactions have already been imported.");
      }
      throw error;
    }
  }

  async listImports(businessId: string) {
    return prisma.onlineReportImportBatch.findMany({
      where: { businessId, platform: "SHOPEE" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        reportFrom: true,
        reportTo: true,
        sourceRowCount: true,
        importedRowCount: true,
        summary: true,
        createdAt: true,
      },
    });
  }

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
    const [pos, onlineRecords, batches] = await Promise.all([
      prisma.channelDailyProductMetric.findMany({
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
      }),
      prisma.onlineReportRecord.findMany({
        where: {
          businessId,
          platform: "SHOPEE",
          OR: [
            { transactionDate: { gte: from, lte: to } },
            { settlementDate: { gte: from, lte: to } },
            {
              transactionDate: null,
              settlementDate: null,
              batch: { reportFrom: { lte: to }, reportTo: { gte: from } },
            },
          ],
        },
        orderBy: [{ transactionDate: "asc" }, { settlementDate: "asc" }],
        take: MAX_AI_READY_ROWS,
        select: {
          recordType: true,
          externalOrderId: true,
          externalProductId: true,
          productName: true,
          transactionDate: true,
          settlementDate: true,
          financialData: true,
          sourceSheet: true,
        },
      }),
      prisma.onlineReportImportBatch.findMany({
        where: {
          businessId,
          platform: "SHOPEE",
          reportFrom: { lte: to },
          reportTo: { gte: from },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, reportFrom: true, reportTo: true, importedRowCount: true, createdAt: true },
      }),
    ]);

    return {
      range,
      pos: {
        metrics: pos,
        hasMetrics: pos.length > 0,
      },
      shopee: {
        financialRecords: onlineRecords,
        recordLimit: MAX_AI_READY_ROWS,
        batches,
        quantityDataAvailable: false,
        notes: [
          "SKU-level units sold are unavailable in this report and must not be inferred.",
          "Adjustment, service fee detail, and shipping discrepancy rows remain separate from order totals.",
        ],
      },
    };
  }
}

export const businessDataService = new BusinessDataService();
