const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

function mock(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];
const sourceItems = ids.map((variantId, index) => ({
  variantId, sku: `SYNTHETIC-${index + 1}`, product: `Synthetic product ${index + 1}`,
}));
let outlook;
let calls = [];
mock("../src/modules/ai-insights/inventory-outlook.service", {
  inventoryOutlook: async (businessId, query, options) => {
    calls.push({ businessId, query, options });
    return outlook;
  },
});
const { answerPreviousOverstock } = require("../src/modules/assistant/previous-restock.service");
const { hasPreviousActions } = require("../src/modules/assistant/previous-actions.service");

function previousEvidence(overrides = {}) {
  return {
    type: "slow_expiry_v1", state: "ready", totalSku: sourceItems.length, items: sourceItems,
    sourceTruncated: true, sourceInventoryCaution: true,
    ...overrides,
  };
}

function overstockSignal(metrics = {}) {
  return {
    type: "OVERSTOCK", current: true, severity: "HIGH",
    metrics: { stockAvailable: 100, daysOfCover: 95, thresholdDays: 60, possibleStockoutBias: false, ...metrics },
  };
}

test("filters only the displayed IDs and preserves their order despite reordered inventory results", async () => {
  calls = [];
  outlook = {
    state: "READY", ruleFresh: true, forecastReady: false, warnings: [],
    latestRun: { dataAsOf: "2026-04-26", finishedAt: new Date("2026-04-27T00:00:00Z") },
    items: [
      { variantId: ids[2], signals: [overstockSignal({ stockAvailable: 30 })] },
      { variantId: ids[1], signals: [] },
      { variantId: ids[0], signals: [overstockSignal({ stockAvailable: 10 })] },
    ],
  };

  const result = await answerPreviousOverstock("business-a", previousEvidence({ state: "partial" }));

  assert.deepEqual(calls, [{
    businessId: "business-a", query: {}, options: { variantIds: ids, all: true },
  }]);
  assert.equal(result.evidence.type, "previous_overstock_v1");
  assert.equal(result.evidence.state, "partial");
  assert.equal(result.evidence.sourceCount, 3);
  assert.equal(result.evidence.sourceTruncated, true);
  assert.equal(result.evidence.totalSku, 2);
  assert.deepEqual(result.evidence.items.map(({ variantId, stockAvailable }) => [variantId, stockAvailable]), [
    [ids[0], 10], [ids[2], 30],
  ]);
  assert.equal(hasPreviousActions(result.evidence), true);
});

test("reports a complete empty result when the fresh displayed SKUs have no overstock alerts", async () => {
  calls = [];
  outlook = {
    state: "READY", ruleFresh: true, warnings: [],
    latestRun: { dataAsOf: "2026-04-26", finishedAt: new Date("2026-04-27T00:00:00Z") },
    items: ids.map((variantId) => ({ variantId, signals: [] })),
  };

  const result = await answerPreviousOverstock("business-a", previousEvidence());

  assert.equal(result.evidence.state, "ready");
  assert.equal(result.evidence.skippedSku, 0);
  assert.equal(result.evidence.totalSku, 0);
  assert.deepEqual(result.evidence.items, []);
  assert.match(result.text, /chưa tìm thấy cảnh báo tồn nhiều hiện hành/);
});

test("marks incomplete active-alert metrics partial but treats absent fresh outlook rows as no alert", async () => {
  calls = [];
  outlook = {
    state: "READY", ruleFresh: true, warnings: [],
    latestRun: { dataAsOf: "2026-04-26", finishedAt: new Date("2026-04-27T00:00:00Z") },
    items: [
      { variantId: ids[0], signals: [overstockSignal({ daysOfCover: undefined })] },
      { variantId: ids[1], signals: [] },
    ],
  };

  const result = await answerPreviousOverstock("business-a", previousEvidence());

  assert.equal(result.evidence.state, "partial");
  assert.equal(result.evidence.skippedSku, 1);
  assert.equal(result.evidence.totalSku, 0);
  assert.deepEqual(result.evidence.items, []);
  assert.match(result.text, /chưa đủ dữ liệu/);
});

test("keeps unavailable inventory distinct and rejects evidence without a prior displayed list", async () => {
  calls = [];
  outlook = { state: "STALE", ruleFresh: false, warnings: [] };
  const result = await answerPreviousOverstock("business-a", previousEvidence());
  assert.equal(result.evidence.state, "unavailable");
  assert.equal(result.evidence.totalSku, null);
  assert.deepEqual(result.evidence.items, []);

  calls = [];
  await assert.rejects(answerPreviousOverstock("business-a", { type: "slow_expiry_v1", state: "ready", totalSku: 0, items: [] }), {
    statusCode: 400,
  });
  assert.equal(calls.length, 0);
});
