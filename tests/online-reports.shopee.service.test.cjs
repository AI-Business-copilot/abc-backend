const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
const ExcelJS = require("exceljs");

let onlineRows = [];
let onlineQuery;
let historyQuery;
let historyRows = [];
let createdBatch;
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { prisma: {
    channelDailyProductMetric: { findMany: async () => [] },
    onlineReportRecord: { findMany: async (query) => { onlineQuery = query; return onlineRows.slice(0, query.take); } },
    onlineReportImportBatch: { findMany: async (query) => { historyQuery = query; return historyRows; } },
    $transaction: async (operation) => operation({
      onlineReportImportBatch: {
        findUnique: async () => null,
        create: async ({ data }) => { createdBatch = data; return { id: "batch-1" }; },
        update: async ({ data }) => ({
          id: "batch-1",
          reportFrom: createdBatch.reportFrom,
          reportTo: createdBatch.reportTo,
          sourceRowCount: createdBatch.sourceRowCount,
          importedRowCount: data.importedRowCount,
          summary: createdBatch.summary,
          createdAt: new Date("2026-04-23T00:00:00Z"),
        }),
      },
      onlineReportRecord: { createMany: async ({ data }) => ({ count: data.length - 1 }) },
    }),
  } },
};
const { ShopeeReportService } = require("../src/modules/online-reports/shopee/shopee-report.service.ts");
const service = new ShopeeReportService();

function row(index, mappingVersion = 5) {
  return {
    id: `record-${index}`,
    recordType: "ORDER",
    externalOrderId: `order-${index}`,
    externalProductId: null,
    productName: null,
    transactionDate: null,
    settlementDate: new Date("2026-04-21T00:00:00Z"),
    financialData: { sellerReceivedAmount: 100 },
    unmappedFinancialData: index === 0 ? { "Phí mới": -1 } : null,
    sourceSheet: "Doanh thu",
    sourceRow: index + 4,
    batch: {
      id: "batch-1",
      reportFrom: new Date("2026-04-20T00:00:00Z"),
      reportTo: new Date("2026-04-23T00:00:00Z"),
      summary: mappingVersion === null ? null : { mappingVersion, financeTotals: { secret: 999 } },
    },
  };
}

test("Shopee records retain provenance, tenant scope and explicit truncation", async () => {
  onlineRows = Array.from({ length: 2001 }, (_, index) => row(index, index === 1 ? null : 5));
  const result = await service.getFinancialRecords("business-1", "2026-04-20", "2026-04-23");
  assert.equal(onlineQuery.where.businessId, "business-1");
  assert.equal(onlineQuery.take, 2001);
  assert.deepEqual(onlineQuery.orderBy[2], { id: "asc" });
  assert.equal(result.recordsTruncated, true);
  assert.equal(result.financialRecords.length, 2000);
  assert.equal(result.quarantinedFinancialRecords, 1);
  assert.equal(result.financialRecords[0].sourceRow, 4);
  assert.equal(result.financialRecords[0].batch.mappingVersion, 5);
  assert.equal(result.financialRecords[1].batch.mappingVersion, null);
  assert.equal(result.financialRecords[0].batch.summary, undefined);
  assert.deepEqual(result.financialRecords[0].unmappedFinancialData, { "Phí mới": -1 });
  assert.equal(result.shopee, undefined);
});

test("exactly the row limit is not falsely marked truncated", async () => {
  onlineRows = Array.from({ length: 2000 }, (_, index) => row(index));
  const result = await service.getFinancialRecords("business-1", "2026-04-20", "2026-04-23");
  assert.equal(result.recordsTruncated, false);
  assert.equal(result.financialRecords.length, 2000);
});

test("import history remains scoped and exposes current mapping version", async () => {
  historyRows = [{ id: "batch-1", summary: { mappingVersion: 4 } }];
  const history = await service.listImports("business-2");
  assert.equal(history[0].summary.mappingVersion, 4);
  assert.equal(history[0].currentMappingVersion, 5);
  assert.equal(historyQuery.where.businessId, "business-2");
  assert.equal(historyQuery.where.platform, "SHOPEE");
  assert.equal(historyQuery.take, 50);
});

test("import summary distinguishes parsed file totals from inserted rows", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Doanh thu");
  [
    ["Đơn hàng / Sản phẩm", "Mã đơn hàng", "Tổng tiền đã thanh toán"],
    ["Order", "ORDER-1", 100],
    ["Order", "ORDER-2", 200],
  ].forEach((row, i) => row.forEach((value, j) => { sheet.getCell(i + 1, j + 1).value = value; }));
  const result = await service.importReport("business-1", "user-1", Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(result.importedRowCount, 1);
  assert.equal(result.skippedDuplicateRows, 1);
  assert.equal(createdBatch.businessId, "business-1");
  assert.equal(createdBatch.summary.uniqueRowCount, 2);
  assert.equal(createdBatch.summary.counts.ORDER, 2);
  assert.equal(createdBatch.summary.financeTotals.sellerReceivedAmount, 300);
});
