const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");

const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
const id = "11111111-1111-4111-8111-111111111111";
let transactionOptions;
let productQuery;
let listQuery;
let categoryQuery;
let insightQuery;
let forecastQuery;
let forecastRow;
let runRow;
const tx = {
  $queryRaw: async () => [{ today: "2026-04-24", at: new Date("2026-04-24T05:00:00Z") }],
  productVariant: { findFirst: async (query) => {
    productQuery = query;
    return query.where.businessId === "business-1" ? { id, sku: "SKU-1", basePrice: new Prisma.Decimal(100), costPrice: new Prisma.Decimal(50), isActive: true, template: { name: "Áo" } } : null;
  } },
  aiInsightRun: { findFirst: async (query) => { insightQuery = query; return runRow; } },
  aiForecast: { findUnique: async (query) => { forecastQuery = query; return forecastRow; } },
};
require.cache[databasePath] = {
  id: databasePath, filename: databasePath, loaded: true,
  exports: { prisma: {
    $transaction: async (callback, options) => { transactionOptions = options; return callback(tx); },
    productVariant: { findMany: async (query) => { listQuery = query; return Array.from({ length: 26 }, (_, index) => ({ id: `${index}`, sku: `SKU-${index}`, isActive: true, template: { name: "Áo" } })).slice(query.skip, query.skip + query.take); } },
    category: { findMany: async (query) => { categoryQuery = query; return Array.from({ length: 10 }, (_, index) => ({
      id: `${index}`, name: `Category ${index}`, isActive: true, parent: { name: "Parent", businessId: index === 8 ? "other-business" : "business-1" },
    })).slice(query.skip, query.skip + query.take); } },
  } },
};
const { calculateComparison, calculateScenario, simulateProfit, simulationForecast, getSimulationBasis, searchSimulationCategories, searchSimulationVariants } = require("../src/modules/business-data/profit-simulation.service.ts");

const baseline = { quantity: "100", price: "100000", unitCost: "60000", discountPercent: "10", operatingExpense: "1000000" };
const scenario = { quantity: "110", price: "100000", unitCost: "60000", discountPercent: "5", operatingExpense: "1000000" };
const run = { id: "run-1", status: "SUCCEEDED", dataAsOf: new Date("2026-04-23T00:00:00Z"), finishedAt: new Date("2026-04-24T02:00:00Z"), summary: { publicationVersion: 1, forecastStatus: "READY" } };
const forecast = { runId: "run-1", asOf: run.dataAsOf, status: "OK", model: "SES", confidence: "LOW", updatedAt: new Date("2026-04-24T01:59:00Z"), result: {
  modelVersion: "v1", datasetKind: "synthetic", nextDayForecast: { status: "OK", policy: "next-day-v1", totals: { d7: 12.345, d14: 20, d28: 40 } },
} };

test("calculates scenarios, cost assumptions and signed differences exactly", () => {
  const result = calculateComparison(baseline, scenario);
  assert.equal(result.baseline.grossSales, "10000000.00");
  assert.equal(result.baseline.discountAmount, "1000000.00");
  assert.equal(result.baseline.grossProfit, "3000000.00");
  assert.equal(result.scenario.grossProfit, "3850000.00");
  assert.equal(result.changes.grossProfit.difference, "850000.00");
  assert.equal(result.changes.afterExpense.difference, "850000.00");
  const loss = calculateComparison({ ...baseline, quantity: "0", operatingExpense: null }, { ...scenario, discountPercent: "100", operatingExpense: "0" });
  assert.equal(loss.baseline.afterExpense, null);
  assert.equal(loss.changes.afterExpense, null);
  assert.equal(loss.scenario.grossProfit, "-6600000.00");
  assert.equal(loss.changes.grossProfit.percent, null);
});

test("category lookup and SKU filters are tenant-scoped, paginated and include direct children", async () => {
  const first = await searchSimulationCategories("business-1", { search: " áo ", pageSize: "8" });
  assert.equal(categoryQuery.where.businessId, "business-1");
  assert.deepEqual(categoryQuery.where.name, { contains: "áo", mode: "insensitive" });
  assert.equal(categoryQuery.take, 9);
  assert.equal(first.hasMore, true);
  assert.equal(first.items[0].parentName, "Parent");
  const second = await searchSimulationCategories("business-1", { page: "2", pageSize: "8" });
  assert.equal(categoryQuery.skip, 8);
  assert.equal(second.items.length, 2);
  assert.equal(second.items[0].parentName, null);
  assert.equal(second.hasMore, false);
  await assert.rejects(searchSimulationCategories("business-1", { pageSize: "51" }), /không hợp lệ/);
  await searchSimulationVariants("business-1", { categoryId: id, search: "áo" });
  assert.deepEqual(listQuery.where.template, {
    businessId: "business-1",
    category: { businessId: "business-1", OR: [{ id }, { parent: { id, businessId: "business-1" } }] },
  });
  assert.equal(listQuery.where.OR.length, 2);
  await searchSimulationVariants("business-1", { categoryId: "uncategorized" });
  assert.deepEqual(listQuery.where.template, { businessId: "business-1", categoryId: null });
  await assert.rejects(searchSimulationVariants("business-1", { categoryId: "invalid" }), /Danh mục không hợp lệ/);
});

test("rounds components once and rejects invalid or excessive input without defaulting", () => {
  const result = calculateScenario({ quantity: "0.01", price: "1.50", unitCost: "0.50", discountPercent: "50", operatingExpense: null });
  assert.equal(result.grossSales, "0.02");
  assert.equal(result.discountAmount, "0.01");
  assert.equal(result.cogs, "0.01");
  assert.equal(result.grossProfit, "0.00");
  for (const [field, value] of [["quantity", "-1"], ["price", "1.234"], ["unitCost", ""], ["discountPercent", "100.01"], ["quantity", "1000000.01"], ["operatingExpense", "1e2"]]) {
    assert.throws(() => calculateScenario({ ...baseline, [field]: value }), /không|vượt/);
  }
  assert.equal(calculateScenario({ ...baseline, discountPercent: "100" }).revenue, "0.00");
  assert.equal(new Prisma.Decimal(result.grossSales).minus(result.discountAmount).toFixed(2), result.revenue);
  const large = calculateScenario({ quantity: "999999.99", price: "9999999999.99", unitCost: "9999999999.98", discountPercent: "99.99", operatingExpense: null });
  assert.equal(large.grossSales, "9999999899990000.00");
  assert.equal(large.discountAmount, "9998999900000001.00");
  assert.equal(large.revenue, "999999989999.00");
  assert.equal(large.grossProfit, "-9998999899990001.00");
});

test("only uses the latest published and timely complete-day forecast", () => {
  const ready = simulationForecast("2026-04-24", run, forecast);
  assert.equal(ready.status, "READY");
  assert.equal(ready.start, "2026-04-25");
  assert.equal(ready.totals.d7, "12.35");
  assert.equal(simulationForecast("2026-04-25", run, forecast).status, "UNAVAILABLE");
  assert.equal(simulationForecast("2026-04-24", { ...run, status: "RUNNING" }, forecast).status, "UNAVAILABLE");
  assert.equal(simulationForecast("2026-04-24", { ...run, summary: { forecastStatus: "READY" } }, forecast).status, "UNAVAILABLE");
  assert.equal(simulationForecast("2026-04-24", run, { ...forecast, runId: "old" }).status, "UNAVAILABLE");
  assert.equal(simulationForecast("2026-04-24", run, { ...forecast, status: "INSUFFICIENT_DATA" }).status, "UNAVAILABLE");
  assert.equal(simulationForecast("2026-04-24", run, { ...forecast, result: { nextDayForecast: { status: "UNAVAILABLE", reason: "MODEL_NOT_CONFIGURED" } } }).status, "UNAVAILABLE");
  assert.equal(simulationForecast("2026-04-24", { ...run, finishedAt: new Date("2026-04-24T17:00:00Z") }, forecast).status, "UNAVAILABLE");
  assert.throws(() => simulationForecast("2026-04-24", run, { ...forecast, result: { nextDayForecast: { status: "OK", policy: "next-day-v1", totals: { d7: 10, d14: 5, d28: 20 } } } }), /không hợp lệ/);
});

test("calculation is scoped to the business and rejects a stale period", async () => {
  const body = { variantId: id, days: 7, start: "2026-04-25", baseline, scenario };
  const result = await simulateProfit("business-1", body);
  assert.equal(result.period.end, "2026-05-01");
  assert.equal(productQuery.where.businessId, "business-1");
  assert.equal(productQuery.where.template.businessId, "business-1");
  assert.equal(transactionOptions.isolationLevel, "RepeatableRead");
  await assert.rejects(simulateProfit("other-business", body), /Không tìm thấy/);
  await assert.rejects(simulateProfit("business-1", { ...body, start: "2026-04-24" }), /đã thay đổi/);
  await assert.rejects(simulateProfit("business-1", { ...body, days: 30 }), /7, 14 hoặc 28/);
});

test("basis and SKU search scope reads to the business and preserve forecast snapshot metadata", async () => {
  runRow = run; forecastRow = forecast;
  const basis = await getSimulationBasis("business-1", { variantId: id });
  assert.equal(productQuery.where.businessId, "business-1");
  assert.equal(insightQuery.where.businessId, "business-1");
  assert.equal(forecastQuery.where.businessId_variantId.businessId, "business-1");
  assert.equal(transactionOptions.isolationLevel, "RepeatableRead");
  assert.equal(basis.variant.basePrice, "100.00");
  assert.equal(basis.forecast.status, "READY");
  assert.equal(basis.forecast.dataAsOf, "2026-04-23");
  await assert.rejects(getSimulationBasis("other-business", { variantId: id }), /Không tìm thấy/);
  const list = await searchSimulationVariants("business-1", { search: " áo " });
  assert.equal(listQuery.where.businessId, "business-1");
  assert.equal(listQuery.where.template.businessId, "business-1");
  assert.equal(list.items.length, 25);
  assert.equal(list.hasMore, true);
  const second = await searchSimulationVariants("business-1", { search: " áo ", page: "2", pageSize: "25" });
  assert.equal(listQuery.skip, 25);
  assert.equal(listQuery.take, 26);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].sku, "SKU-25");
  assert.equal(second.hasMore, false);
  await assert.rejects(searchSimulationVariants("business-1", { page: "0" }), /không hợp lệ/);
  await assert.rejects(searchSimulationVariants("business-1", { pageSize: "51" }), /không hợp lệ/);
});
