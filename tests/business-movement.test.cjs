const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

const performancePath = require.resolve("../src/modules/business-data/product-performance.service.ts");
let calls = [];
const comparison = {
  current: { grossSales: "1100.00", discountAmount: "40.00", refundAmount: "160.00", netRevenue: "900.00", netCogs: "640.00", grossProfit: "260.00" },
  previous: { grossSales: "1200.00", discountAmount: "50.00", refundAmount: "150.00", netRevenue: "1000.00", netCogs: "700.00", grossProfit: "300.00" },
};
const snapshot = { totals: comparison, items: [], warnings: {}, asOf: new Date("2026-04-24T00:00:00Z") };
require.cache[performancePath] = {
  id: performancePath, filename: performancePath, loaded: true,
  exports: {
    performanceRanges: (from, to) => ({ current: { from, to } }),
    getProductPerformance: async (businessId, query) => { calls.push({ businessId, query }); return snapshot; },
  },
};
const { buildBusinessMovement, getBusinessMovement } = require("../src/modules/business-data/business-movement.service.ts");

test("decomposes revenue and profit with the correct accounting signs", () => {
  const result = buildBusinessMovement(snapshot);
  assert.equal(result.components.grossSales.impact, "-100.00");
  assert.equal(result.components.discountAmount.difference, "-10.00");
  assert.equal(result.components.discountAmount.impact, "10.00");
  assert.equal(result.components.refundAmount.impact, "-10.00");
  assert.equal(result.components.netRevenue.impact, "-100.00");
  assert.equal(result.components.netCogs.impact, "60.00");
  assert.equal(result.asOf, snapshot.asOf);
});

test("uses one complete scoped snapshot and rejects future dates before reading POS", async () => {
  calls = [];
  await getBusinessMovement("business-1", { from: "2026-04-20", to: "2026-04-23", all: "false", search: "ignored" });
  assert.deepEqual(calls, [{ businessId: "business-1", query: { from: "2026-04-20", to: "2026-04-23", all: "true" } }]);
  await assert.rejects(getBusinessMovement("business-1", { from: "9999-01-01", to: "9999-01-02" }), /future/);
  assert.equal(calls.length, 1);
});
