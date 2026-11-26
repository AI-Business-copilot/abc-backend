const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");

const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
let transactionOptions;
let variantQuery;
let returnedVariants = [{ id: "v1", sku: "DEMO-1", templateId: "p1", template: { name: "Áo" } }];
const tx = {
  productVariant: { findMany: async (query) => {
    variantQuery = query;
    return returnedVariants;
  } },
  $queryRaw: async (strings, ...values) => {
    if (strings.join("").includes("transaction_timestamp")) return [{ at: new Date("2026-04-24T00:00:00Z") }];
    assert.equal(values[0], "business-1");
    assert.equal(values[1].toISOString(), "2026-04-15T17:00:00.000Z");
    assert.equal(values[2].toISOString(), "2026-04-23T17:00:00.000Z");
    return [{ count: 1 }];
  },
};
require.cache[databasePath] = {
  id: databasePath, filename: databasePath, loaded: true,
  exports: { prisma: { $transaction: async (callback, options) => { transactionOptions = options; return callback(tx); } } },
};
const { buildPosMetricRows, businessDataService } = require("../src/modules/business-data/business-data.service.ts");
const { buildPerformance, getProductPerformance, performanceRanges } = require("../src/modules/business-data/product-performance.service.ts");
const { buildBusinessMovement } = require("../src/modules/business-data/business-movement.service.ts");
const d = (value) => new Prisma.Decimal(value);
const variants = [
  { id: "v1", sku: "SKU-1", templateId: "p1", template: { name: "Áo" } },
  { id: "v2", sku: "SKU-2", templateId: "p1", template: { name: "Áo" } },
  { id: "v3", sku: "SKU-3", templateId: "p2", template: { name: "Kem" } },
];
const sale = (day, variantId, units, gross, discount, cogs) => ({
  metricDate: day, variantId, unitsSold: units, orderCount: 1,
  grossSales: d(gross), discountAmount: d(discount), cogs: d(cogs),
});
const returned = (day, variantId, units, refund, returnedCogs) => ({
  metricDate: day, variantId, unitsReturned: units, refundAmount: d(refund), returnedCogs: d(returnedCogs),
});

test("aggregates variants, discounts and cross-period returns without losing negative values", () => {
  const rows = buildPosMetricRows("business-1", [
    sale("2026-04-19", "v1", 2, 200, 0, 100),
    sale("2026-04-21", "v1", 10, 1000, 20, 500),
    sale("2026-04-22", "v2", 1, 100, 0, 50),
  ], [
    returned("2026-04-23", "v1", 1, 90, 50),
    returned("2026-04-23", "v3", 1, 45, 0),
  ]);
  const result = buildPerformance(rows, variants, "2026-04-20");
  const shirt = result.products.find((item) => item.id === "p1");
  assert.equal(shirt.current.netRevenue, "990.00");
  assert.equal(shirt.current.netCogs, "500.00");
  assert.equal(shirt.current.grossProfit, "490.00");
  assert.equal(shirt.current.marginPercent, "49.49");
  assert.equal(shirt.previous.netRevenue, "200.00");
  assert.equal(shirt.changes.netRevenue.percent, "395.00");
  assert.equal(shirt.variants.length, 2);
  const returnOnly = result.products.find((item) => item.id === "p2");
  assert.equal(returnOnly.current.netRevenue, "-45.00");
  assert.equal(returnOnly.current.grossProfit, "-45.00");
  assert.equal(returnOnly.current.marginPercent, null);
  assert.equal(returnOnly.changes.netRevenue.percent, null);
  assert.equal(result.totals.current.netRevenue, "945.00");
});

test("builds adjacent equal periods and rejects invalid or oversized ranges", () => {
  assert.deepEqual(performanceRanges("2026-01-01", "2026-01-07").previous, {
    from: "2025-12-25", to: "2025-12-31", dayCount: 7,
  });
  assert.throws(() => performanceRanges("2026-02-30", "2026-03-01"), /valid date/);
  assert.throws(() => performanceRanges("2026-01-01", "2026-07-04"), /183 days/);
});

test("reads both periods in one scoped snapshot and reports cost-link warnings", async () => {
  const rows = buildPosMetricRows("business-1", [sale("2026-04-21", "v1", 1, 100, 10, 40)], []);
  businessDataService.readPosSource = async (client, businessId, from, to) => {
    assert.equal(client, tx);
    assert.equal(businessId, "business-1");
    assert.equal(from, "2026-04-16");
    assert.equal(to, "2026-04-23");
    return { rows, sourceAnomalies: { invalidSaleItems: 2, invalidReturnItems: 3 } };
  };
  const result = await getProductPerformance("business-1", { from: "2026-04-20", to: "2026-04-23", search: "demo", pageSize: "1" });
  assert.equal(transactionOptions.isolationLevel, "RepeatableRead");
  assert.equal(variantQuery.where.businessId, "business-1");
  assert.equal(variantQuery.where.template.businessId, "business-1");
  assert.equal(result.items[0].current.grossProfit, "50.00");
  assert.equal(result.hasSyntheticSku, true);
  assert.deepEqual(result.warnings, { excludedSaleItems: 2, excludedReturnItems: 3, missingReturnCostLinks: 1 });
  await assert.rejects(getProductPerformance("business-1", { from: "2026-04-20", to: "2026-04-23", sort: "other" }), /Invalid sort/);
});

test("sorts the complete result before paging while keeping totals independent of search", async () => {
  returnedVariants = [
    { id: "v1", sku: "SKU-1", templateId: "p1", template: { name: "Áo" } },
    { id: "v2", sku: "SKU-2", templateId: "p2", template: { name: "Kem" } },
  ];
  const rows = buildPosMetricRows("business-1", [
    sale("2026-04-21", "v1", 1, 100, 0, 40),
    sale("2026-04-21", "v2", 1, 300, 0, 200),
  ], []);
  businessDataService.readPosSource = async () => ({
    rows, sourceAnomalies: { invalidSaleItems: 0, invalidReturnItems: 0 },
  });
  const first = await getProductPerformance("business-1", { from: "2026-04-20", to: "2026-04-23", sort: "revenue", pageSize: "1" });
  const second = await getProductPerformance("business-1", { from: "2026-04-20", to: "2026-04-23", sort: "revenue", pageSize: "1", page: "2" });
  const searched = await getProductPerformance("business-1", { from: "2026-04-20", to: "2026-04-23", search: "SKU-1" });
  assert.equal(first.items[0].name, "Kem");
  assert.equal(second.items[0].name, "Áo");
  assert.equal(searched.pagination.total, 1);
  assert.equal(searched.items[0].name, "Áo");
  assert.equal(searched.totals.current.netRevenue, "400.00");
});

test("all=true returns the entire snapshot beyond the page limit", async () => {
  returnedVariants = Array.from({ length: 60 }, (_, index) => ({
    id: `v${index}`, sku: `SKU-${index}`, templateId: `p${index}`, template: { name: `Product ${index}` },
  }));
  const rows = buildPosMetricRows("business-1", returnedVariants.map((variant) => sale("2026-04-21", variant.id, 1, 100, 0, 40)), []);
  businessDataService.readPosSource = async () => ({ rows, sourceAnomalies: { invalidSaleItems: 0, invalidReturnItems: 0 } });
  const paged = await getProductPerformance("business-1", { from: "2026-04-20", to: "2026-04-23", pageSize: "50" });
  const snapshot = await getProductPerformance("business-1", { from: "2026-04-20", to: "2026-04-23", all: "true" });
  assert.equal(paged.items.length, 50);
  assert.equal(snapshot.items.length, 60);
  assert.equal(snapshot.pagination.total, 60);
  assert.equal(snapshot.pagination.totalPages, 1);
  assert.equal(snapshot.totals.current.netRevenue, paged.totals.current.netRevenue);
  await assert.rejects(getProductPerformance("business-1", { from: "2026-04-20", to: "2026-04-23", all: "false" }), /Invalid all/);
});

test("movement components and product contributions reconcile with the POS snapshot", async () => {
  returnedVariants = variants;
  const rows = buildPosMetricRows("business-1", [
    sale("2026-04-19", "v1", 2, 200, 0, 100),
    sale("2026-04-21", "v1", 10, 1000, 20, 500),
    sale("2026-04-22", "v2", 1, 100, 0, 50),
  ], [returned("2026-04-23", "v1", 1, 90, 50), returned("2026-04-23", "v3", 1, 45, 0)]);
  businessDataService.readPosSource = async () => ({ rows, sourceAnomalies: { invalidSaleItems: 0, invalidReturnItems: 0 } });
  const result = buildBusinessMovement(await getProductPerformance("business-1", { from: "2026-04-20", to: "2026-04-23", all: "true" }));
  for (const metric of ["netRevenue", "grossProfit"]) {
    const sum = result.items.reduce((total, item) => total.plus(item.changes[metric].difference), d(0));
    assert.equal(sum.toFixed(2), result.totals.changes[metric].difference);
    for (const item of result.items) {
      assert.equal(item.variants.reduce((total, variant) => total.plus(variant.changes[metric].difference), d(0)).toFixed(2), item.changes[metric].difference);
    }
  }
  const c = result.components;
  assert.equal(d(c.grossSales.impact).plus(c.discountAmount.impact).plus(c.refundAmount.impact).toFixed(2), result.totals.changes.netRevenue.difference);
  assert.equal(d(c.netRevenue.impact).plus(c.netCogs.impact).toFixed(2), result.totals.changes.grossProfit.difference);
  assert.equal(result.items.find((item) => item.id === "p2").changes.netRevenue.difference, "-45.00");
  assert.equal(result.items.find((item) => item.id === "p2").changes.netRevenue.percent, null);
});
