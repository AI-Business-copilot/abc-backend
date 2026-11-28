const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
function mock(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
const warnings = { excludedSaleItems: 0, excludedReturnItems: 0, missingReturnCostLinks: 0 };
const ranking = { type: "top_sellers_v1", period: { from: "2026-04-20", to: "2026-04-26" },
  salesAsOf: "2026-04-27T00:00:00Z", warnings,
  items: ids.map((variantId, i) => ({ variantId, sku: `S${i}`, product: "Synthetic", unitsSold: 20 - i })) };
let outlook, lots, calls, queries;
mock("../src/modules/assistant/sku-analysis.service", { rankTopSellers: async (businessId) => { calls.push(["ranking", businessId]); return ranking; } });
mock("../src/modules/ai-insights/inventory-outlook.service", { inventoryOutlook: async (...args) => { calls.push(["outlook", ...args]); return outlook; } });
mock("../src/shared/infrastructure/database/prisma.client", { prisma: {
  $transaction: async (fn, options) => {
    assert.equal(options.isolationLevel, "RepeatableRead");
    let count = 0;
    return fn({ $queryRaw: async (strings, ...values) => {
      queries.push({ sql: strings.join("?"), values });
      return count++ === 0 ? [{ asOf: new Date("2026-04-27T00:00:00Z"), today: "2026-04-27" }] : lots;
    } });
  },
} });
const { answerTopSellerInventory } = require("../src/modules/assistant/top-seller-inventory.service");
const { answerPreviousNearExpiry } = require("../src/modules/assistant/previous-near-expiry.service");
function setup() {
  calls = []; queries = []; lots = [];
  outlook = { state: "READY", ruleFresh: true, forecastReady: false, warnings: [],
    latestRun: { dataAsOf: "2026-04-26", finishedAt: new Date("2026-04-27T00:00:00Z") },
    items: [{ variantId: ids[1], signals: [{ type: "OVERSTOCK", current: true, metrics: { stockAvailable: 100, daysOfCover: 80, thresholdDays: 60 } }] },
      { variantId: ids[2], signals: [{ type: "OVERSTOCK", current: false, metrics: {} }] }] };
}

test("overstock filters the already-ranked five and distinguishes unavailable and partial data", async () => {
  setup();
  const result = await answerTopSellerInventory("tenant", "top_sellers_overstock");
  assert.deepEqual(result.evidence.items.map((row) => row.variantId), [ids[1]]);
  assert.equal(result.evidence.rankingCount, 5);
  assert.equal(result.evidence.state, "ready");
  assert.deepEqual(calls[1], ["outlook", "tenant", {}, { variantIds: ids, all: true }]);
  outlook.ruleFresh = false;
  assert.equal((await answerTopSellerInventory("tenant", "top_sellers_overstock")).evidence.state, "unavailable");
  outlook.ruleFresh = true; outlook.warnings = null;
  assert.equal((await answerTopSellerInventory("tenant", "top_sellers_overstock")).evidence.state, "partial");
});

test("near-expiry keeps ranked scope, lot statuses and counts all lots before limiting display", async () => {
  setup();
  lots = Array.from({ length: 6 }, (_, i) => ({
    variantId: ids[0], lotItemId: `l${i}`, lotNumber: `L${i}`, expirationDate: "2026-04-30",
    status: i === 0 ? "QUARANTINED" : "WARNING", alertDays: 30, quantity: 8, damaged: 2,
  }));
  const result = await answerTopSellerInventory("tenant", "top_sellers_near_expiry");
  assert.equal(result.evidence.items[0].totalLots, 6);
  assert.equal(result.evidence.items[0].lots.length, 5);
  assert.equal(result.evidence.items[0].lots[0].status, "QUARANTINED");
  assert.equal(result.evidence.inventoryDay, "2026-04-27");
  assert.equal(result.evidence.totalSku, 1);
  assert.match(queries[1].sql, /expiration_date" >=/);
  assert.match(queries[1].sql, /COALESCE\(li\."alert_days_before", 30\)/);
  assert.ok(queries[1].values.includes("tenant"));
});

test("previous list limits the lot query to the tenant and displayed SKU identifiers", async () => {
  setup();
  const prior = { type: "slow_expiry_v1", state: "ready", totalSku: 3, items: [
    { variantId: ids[1], sku: "S1", product: "A" },
    { variantId: ids[3], sku: "S3", product: "B" },
  ] };
  await answerPreviousNearExpiry("tenant", prior);
  assert.equal(queries[1].values[0], "tenant");
  assert.deepEqual(queries[1].values[1].values, [ids[1], ids[3]]);
  assert.match(queries[1].sql, /ib\."business_id" = /);
});
