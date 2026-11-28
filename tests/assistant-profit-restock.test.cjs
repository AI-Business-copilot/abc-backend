const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

function mock(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
let performance;
let outlook;
let calls = [];
mock("../src/modules/business-data/product-performance.service", { getProductPerformance: async (...args) => {
  calls.push(["sales", ...args]); return performance;
} });
mock("../src/modules/ai-insights/inventory-outlook.service", { inventoryOutlook: async (...args) => {
  calls.push(["inventory", ...args]); return outlook;
} });
const { answerProfitRestock } = require("../src/modules/assistant/profit-restock.service");
const warnings = { excludedSaleItems: 0, excludedReturnItems: 0, missingReturnCostLinks: 0 };
const variant = (id, profit) => ({ id, sku: `SKU-${id}`, current: { grossProfit: profit } });
const suggestion = (id, overrides = {}) => ({ variantId: id, replenishment: {
  status: "PENDING", current: true, suggestedQty: 4, urgency: "HIGH", supplierName: null,
  orderByDate: null, stockoutDate: null, ...overrides,
} });
const setup = () => {
  calls = [];
  performance = { asOf: new Date("2026-04-27T00:00:00Z"), warnings, items: [{ name: "Synthetic", variants: [
    variant("a", "9007199254740992.99"), variant("b", "9007199254740993.00"),
    variant("c", "10.00"), variant("d", "10.00"), variant("e", "9.00"), variant("f", "8.00"),
    variant("zero", "0.00"), variant("loss", "-1.00"), variant("no-suggestion", "99999999999999999.00"),
    variant("stale", "9999.00"), variant("ordered", "9998.00"),
  ] }] };
  outlook = { state: "READY", ruleFresh: true, forecastReady: true, warnings: [],
    latestRun: { dataAsOf: "2026-04-26", finishedAt: new Date("2026-04-27T00:00:00Z") },
    items: ["a", "b", "c", "d", "e", "f", "zero", "loss"].map((id) => suggestion(id)).concat([
      suggestion("stale", { current: false }), suggestion("ordered", { status: "ORDERED", current: true }),
    ]),
  };
};

test("filters current pending suggestions before ranking positive gross profit with exact money", async () => {
  setup();
  const result = await answerProfitRestock("business-a");
  assert.deepEqual(result.evidence.items.map((item) => item.variantId), ["b", "a", "c", "d", "e"]);
  assert.equal(result.evidence.items[0].grossProfit, "9007199254740993.00");
  assert.equal(result.evidence.totalSku, 6);
  assert.equal(result.evidence.state, "ready");
  const sales = calls.find(([name]) => name === "sales");
  assert.equal(sales[1], "business-a");
  assert.equal(sales[2].all, "true");
  assert.equal((Date.parse(sales[2].to) - Date.parse(sales[2].from)) / 86400000, 29);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  assert.equal(Date.parse(today) - Date.parse(sales[2].to), 86400000);
  assert.deepEqual(calls.find(([name]) => name === "inventory"), ["inventory", "business-a", {}, { all: true }]);
});

test("separates unavailable, partial and genuinely empty results", async () => {
  setup(); outlook.forecastReady = false;
  const unavailable = await answerProfitRestock("business-a");
  assert.equal(unavailable.evidence.state, "unavailable");
  assert.equal(unavailable.evidence.totalSku, null);
  assert.deepEqual(unavailable.evidence.items, []);
  outlook.forecastReady = true; outlook.ruleFresh = false;
  assert.equal((await answerProfitRestock("business-a")).evidence.state, "unavailable");
  outlook = { state: "RUNNING", latestRun: null, items: null };
  assert.equal((await answerProfitRestock("business-a")).evidence.state, "unavailable");
  setup(); outlook.warnings = [{ code: "FORECAST_CENSORED_HISTORY" }];
  assert.equal((await answerProfitRestock("business-a")).evidence.state, "partial");
  outlook.warnings = null;
  assert.equal((await answerProfitRestock("business-a")).evidence.state, "partial");
  outlook.warnings = []; performance.warnings = { ...warnings, missingReturnCostLinks: 1 };
  assert.equal((await answerProfitRestock("business-a")).evidence.state, "partial");
  setup(); outlook.items = [];
  const empty = await answerProfitRestock("business-a");
  assert.equal(empty.evidence.state, "ready");
  assert.equal(empty.evidence.totalSku, 0);
  assert.match(empty.text, /Chưa tìm thấy/);
  outlook.items = null;
  await assert.rejects(answerProfitRestock("business-a"), /missing current items/);
});
