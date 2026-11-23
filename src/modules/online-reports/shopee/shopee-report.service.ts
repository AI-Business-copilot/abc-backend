import { Prisma } from "@prisma/client";

import { HttpError } from "../../../shared/http/http-error";
import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { dateRange, metricDate } from "../../../shared/dates/date-range";
import {
  parseShopeeReport,
  SHOPEE_MAPPING_VERSION,
  type ParsedShopeeRecord,
} from "./shopee-report.parser";

const MAX_RECORD_ROWS = 2_000;

export class ShopeeReportService {
  async previewReport(businessId: string, buffer: Buffer) {
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
      mappingVersion: report.mappingVersion,
      alreadyImported: Boolean(existing),
      importedAt: existing?.createdAt ?? null,
      reportFrom: report.reportFrom,
      reportTo: report.reportTo,
      sourceRowCount: report.sourceRowCount,
      uniqueRowCount: report.records.length,
      counts: report.counts,
      financeTotals: report.financeTotals,
      summaryFinancialData: report.summaryFinancialData,
      reconciliations: report.reconciliations,
      unmappedFields: report.unmappedFieldSummaries,
      notes: [
        "Chỉ các trường thuộc danh mục ánh xạ Shopee đã kiểm soát được đưa vào tổng tài chính chuẩn; khoản chưa rõ nghĩa được cách ly riêng.",
        "Tài chính lấy từ các dòng Order; dòng Sku chỉ dùng nhận diện sản phẩm, không cộng lại doanh thu.",
        "Trang Summary được đọc riêng; các khoản cùng định nghĩa được đối chiếu với tổng dòng Order. Chênh lệch cần kiểm tra, không tự sửa dữ liệu.",
        "Adjustment được giữ theo ngày điều chỉnh; phí dịch vụ chi tiết và chênh lệch vận chuyển chỉ dùng đối soát.",
        "Báo cáo này không cung cấp số lượng bán theo SKU nên không dùng để dự báo nhu cầu sản phẩm.",
        "Thông tin người mua và dữ liệu thanh toán cá nhân không được lưu.",
      ],
    };
  }

  async importReport(businessId: string, userId: string, buffer: Buffer) {
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

        const unmappedFields: Prisma.InputJsonArray = report.unmappedFieldSummaries.map((field): Prisma.InputJsonObject => ({
          sourceSheet: field.sourceSheet,
          header: field.header,
          occurrences: field.occurrences,
        }));
        const reconciliations: Prisma.InputJsonArray = report.reconciliations.map((check): Prisma.InputJsonObject => ({
          summaryField: check.summaryField,
          incomeField: check.incomeField,
          summaryAmount: check.summaryAmount,
          incomeAmount: check.incomeAmount,
          difference: check.difference,
          matches: check.matches,
        }));
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
              mappingVersion: report.mappingVersion,
              counts: report.counts,
              uniqueRowCount: report.records.length,
              financeTotals: report.financeTotals,
              summaryFinancialData: report.summaryFinancialData,
              reconciliations,
              unmappedFields,
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
          unmappedFinancialData: record.unmappedFinancialData ?? Prisma.DbNull,
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
    const batches = await prisma.onlineReportImportBatch.findMany({
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
    return batches.map((batch) => ({ ...batch, currentMappingVersion: SHOPEE_MAPPING_VERSION }));
  }

  async getFinancialRecords(businessId: string, fromValue: unknown, toValue: unknown) {
    const range = dateRange(fromValue, toValue);
    const from = metricDate(range.from);
    const to = metricDate(range.to);
    const [onlineRecords, batches] = await Promise.all([
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
        orderBy: [{ transactionDate: "asc" }, { settlementDate: "asc" }, { id: "asc" }],
        take: MAX_RECORD_ROWS + 1,
        select: {
          id: true,
          recordType: true,
          externalOrderId: true,
          externalProductId: true,
          productName: true,
          transactionDate: true,
          settlementDate: true,
          financialData: true,
          unmappedFinancialData: true,
          sourceSheet: true,
          sourceRow: true,
          batch: { select: { id: true, reportFrom: true, reportTo: true, summary: true } },
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

    const recordsTruncated = onlineRecords.length > MAX_RECORD_ROWS;
    const visibleRecords = onlineRecords.slice(0, MAX_RECORD_ROWS).map(({ batch, ...record }) => {
      const summary = batch.summary;
      const mappingVersion = summary && typeof summary === "object" && !Array.isArray(summary)
        && typeof summary.mappingVersion === "number" ? summary.mappingVersion : null;
      return {
        ...record,
        batch: { id: batch.id, reportFrom: batch.reportFrom, reportTo: batch.reportTo, mappingVersion },
      };
    });

    return {
      range,
      financialRecords: visibleRecords,
      recordLimit: MAX_RECORD_ROWS,
      recordsTruncated,
      currentMappingVersion: SHOPEE_MAPPING_VERSION,
      batches,
      quantityDataAvailable: false,
      quarantinedFinancialRecords: visibleRecords.filter((record) =>
        record.unmappedFinancialData && Object.keys(record.unmappedFinancialData as Record<string, unknown>).length > 0,
      ).length,
      notes: [
        "Only catalog-mapped financial fields are part of canonical Shopee financial data. Unmapped financial fields are isolated for review and must not be used in calculations.",
        "SKU-level units sold are unavailable in this report and must not be inferred.",
        "Adjustment, service fee detail, and shipping discrepancy rows remain separate from order totals.",
      ],
    };
  }
}

export const shopeeReportService = new ShopeeReportService();
