const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

function mock(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
const ids = Array.from({ length: 7 }, (_, index) => `00000000-0000-4000-8000-00000000000${index + 1}`);
const warnings = { excludedSaleItems: 1, excludedReturnItems: 0, missingReturnCostLinks: 0 };
let salesCalls = [];
let riskCalls = [];
let riskState = "ready";
let salesUnits = [9, 20, 6, 12, 3, 10, 0];
mock("../src/modules/business-data/product-performance.service", { getProductPerformance: async (businessId, query) => {
  salesCalls.push({ businessId, query });
  return {
    asOf: new Date("2026-04-27T00:00:00Z"), warnings,
    items: [{ name: "Sản phẩm A", variants: ids.map((id, index) => ({
      id, sku: `SKU-${index + 1}`, current: { unitsSold: salesUnits[index] },
    })) }],
  };
} });
mock("../src/modules/ai-insights/inventory-outlook.service", { inventoryOutlook: async (businessId, query, options) => {
  riskCalls.push({ businessId, query, options });
  return {
    state: "READY", ruleFresh: riskState !== "stale", forecastReady: riskState !== "forecast",
    latestRun: { dataAsOf: "2026-04-26", finishedAt: new Date("2026-04-27T00:00:00Z") },
    items: [
      { variantId: ids[1], signals: [
        { type: "STOCKOUT_RISK", current: true, severity: "HIGH", metrics: { stockoutDate: "2026-04-30" } },
      ] },
      { variantId: ids[3], signals: [
        { type: "STOCKOUT_RISK", current: false, severity: "CRITICAL", metrics: {} },
      ] },
      { variantId: ids[5], signals: [
        { type: "LOW_STOCK", current: true, severity: "HIGH", metrics: {} },
      ] },
      { variantId: ids[0], signals: [
        { type: "STOCKOUT_RISK", current: true, severity: "HIGH", metrics: {} },
        { type: "STOCKOUT_RISK", current: true, severity: "CRITICAL", metrics: {} },
      ] },
    ],
  };
} });
const { answerSkuQuestion } = require("../src/modules/assistant/sku-analysis.service");

test("ranks five variants by gross units in the last seven completed days", async () => {
  salesCalls = []; riskCalls = [];
  const result = await answerSkuQuestion("business-a", "top_sellers");
  assert.deepEqual(result.evidence.items.map((item) => item.variantId), [ids[1], ids[3], ids[5], ids[0], ids[2]]);
  assert.equal(result.evidence.items[0].unitsSold, 20);
  assert.equal(salesCalls[0].businessId, "business-a");
  const { from, to } = salesCalls[0].query;
  assert.equal((Date.parse(to) - Date.parse(from)) / 86400000, 6);
  assert.equal(riskCalls.length, 0);
});

test("follow-up uses the stored set and only current high stockout signals", async () => {
  salesCalls = []; riskCalls = []; riskState = "ready";
  const ranking = await answerSkuQuestion("business-a", "top_sellers");
  const result = await answerSkuQuestion("business-a", "previous_stockout", ranking.evidence);
  assert.equal(salesCalls.length, 1);
  assert.deepEqual(riskCalls[0].options.variantIds, [ids[1], ids[3], ids[5], ids[0], ids[2]]);
  assert.deepEqual(result.evidence.items.map((item) => [item.variantId, item.severity]), [[ids[1], "HIGH"], [ids[0], "CRITICAL"]]);
  assert.equal(result.evidence.items[0].stockoutDate, "2026-04-30");
  assert.equal(result.evidence.rankingCount, 5);
  assert.equal(result.evidence.riskState, "ready");
});

test("stale forecast is unavailable and missing or malformed context is rejected", async () => {
  salesCalls = []; riskCalls = []; riskState = "stale";
  const result = await answerSkuQuestion("business-a", "top_sellers_stockout");
  assert.equal(result.evidence.riskState, "unavailable");
  assert.deepEqual(result.evidence.items, []);
  assert.match(result.text, /Chưa đủ dữ liệu/);
  await assert.rejects(answerSkuQuestion("business-a", "previous_stockout", null), { statusCode: 400 });
  await assert.rejects(answerSkuQuestion("business-a", "previous_stockout", { ...result.evidence, type: "top_sellers_v1", items: [{ variantId: "bad" }] }), { statusCode: 400 });
  riskState = "forecast";
  assert.equal((await answerSkuQuestion("business-a", "top_sellers_stockout")).evidence.riskState, "unavailable");
});

test("empty sales and tied sales produce stable, bounded results", async () => {
  riskState = "ready";
  salesUnits = [0, 0, 0, 0, 0, 0, 0];
  const empty = await answerSkuQuestion("business-a", "top_sellers_stockout");
  assert.equal(empty.evidence.rankingCount, 0);
  assert.deepEqual(empty.evidence.items, []);
  assert.match(empty.text, /Không có mã hàng/);
  salesUnits = [5, 5, 5, 5, 5, 5, 0];
  const tied = await answerSkuQuestion("business-a", "top_sellers");
  assert.deepEqual(tied.evidence.items.map((item) => item.variantId), ids.slice(0, 5));
});
