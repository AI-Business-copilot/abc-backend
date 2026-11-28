const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

const resolved = require.resolve("../src/modules/ai-insights/inventory-outlook.service");
let outlook;
let calls = [];
require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {
  inventoryOutlook: async (...args) => { calls.push(args); return outlook; },
} };
const { answerSlowExpiry } = require("../src/modules/assistant/slow-expiry.service");

const slow = (current = true) => ({
  type: "SLOW_MOVING", current, metrics: { sold30: 2, daysWithoutSale: 40, neverSold: false, stockAvailable: 8 },
});
const lot = (id, status, date, current = true) => ({
  id, type: "EXPIRATION_RISK", current, severity: "LOW", lotNumber: `lot-${id}`, expirationDate: date,
  reasonCode: status, metrics: { lotQuantity: 4, atRiskQty: 3, costPrice: 999 },
});
const item = (id, signals) => ({ variantId: id, sku: `sku-${id}`, productName: `Product ${id}`, signals });
const ready = (items) => ({
  state: "READY", ruleFresh: true, forecastReady: true, warnings: [],
  latestRun: { dataAsOf: "2026-04-26", finishedAt: new Date("2026-04-27T00:00:00Z") }, items,
});

test("combines current warnings by SKU and preserves separate lots and states", async () => {
  calls = [];
  outlook = ready([
    item("A", [slow(), lot("1", "DEMAND_BELOW_STOCK_BEFORE_EXPIRY", "2026-05-01"), lot("2", "EXPIRED_IN_STOCK", "2026-04-01"), lot("3", "UNSELLABLE_NEAR_EXPIRY", "2026-05-02"), lot("4", "EXPIRED_IN_STOCK", "2026-03-01", false)]),
    item("B", [slow(), lot("5", "DEMAND_BELOW_STOCK_BEFORE_EXPIRY", "2026-05-01", false)]),
    item("C", [slow(false), lot("6", "EXPIRED_IN_STOCK", "2026-04-01")]),
    item("D", [lot("7", "EXPIRED_IN_STOCK", "2026-04-01")]),
  ]);
  const result = await answerSlowExpiry("business-a");
  assert.deepEqual(calls, [["business-a", {}, { all: true }]]);
  assert.equal(result.evidence.state, "ready");
  assert.equal(result.evidence.totalSku, 1);
  const match = result.evidence.items[0];
  assert.equal(match.sold30, 2);
  assert.deepEqual(match.lots.map((entry) => [entry.id, entry.status]), [["2", "expired"], ["3", "unsellable"], ["1", "at_risk"]]);
  assert.equal(match.totalLots, 3);
  assert.equal(JSON.stringify(result).includes("costPrice"), false);
});

test("counts all matches before limiting SKUs and lots", async () => {
  outlook = ready(Array.from({ length: 12 }, (_, i) => item(String(i).padStart(2, "0"), [
    slow(), ...Array.from({ length: 6 }, (_v, j) => lot(`${i}-${j}`, "DEMAND_BELOW_STOCK_BEFORE_EXPIRY", `2026-05-0${j + 1}`)),
  ])));
  const { evidence } = await answerSlowExpiry("business-a");
  assert.equal(evidence.totalSku, 12);
  assert.equal(evidence.items.length, 10);
  assert.equal(evidence.items[0].totalLots, 6);
  assert.equal(evidence.items[0].lots.length, 5);
  assert.equal(evidence.items[0].lots[0].expirationDate, "2026-05-01");
});

test("distinguishes partial, empty and unavailable analyses", async () => {
  outlook = ready([]);
  assert.equal((await answerSlowExpiry("business-a")).evidence.state, "ready");
  outlook.forecastReady = false;
  assert.equal((await answerSlowExpiry("business-a")).evidence.state, "partial");
  outlook.forecastReady = true; outlook.warnings = [{ code: "INSUFFICIENT_HISTORY", message: "incomplete" }];
  assert.equal((await answerSlowExpiry("business-a")).evidence.state, "partial");
  outlook.warnings = null;
  assert.equal((await answerSlowExpiry("business-a")).evidence.state, "partial");
  outlook.ruleFresh = false;
  const stale = await answerSlowExpiry("business-a");
  assert.equal(stale.evidence.state, "unavailable");
  assert.equal(stale.evidence.totalSku, null);
  assert.match(stale.text, /Chưa có phân tích/);
  outlook = { state: "RUNNING", latestRun: null, items: null };
  assert.equal((await answerSlowExpiry("business-a")).evidence.state, "unavailable");
});
