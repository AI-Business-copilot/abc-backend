const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

const path = require.resolve("../src/modules/ai-insights/inventory-outlook.service");
let outlook;
let calls;
require.cache[path] = { id: path, filename: path, loaded: true, exports: {
  inventoryOutlook: async (...args) => { calls.push(args); return outlook; },
} };
const { answerOverstockForecast } = require("../src/modules/assistant/overstock-forecast.service");

const asOf = new Date("2026-04-26T00:00:00Z");
const finishedAt = new Date("2026-04-27T02:00:00Z");
const signal = (id, changes = {}) => ({
  variantId: id, sku: id, productName: `Product ${id}`, signals: [{
    type: "OVERSTOCK", current: true, severity: "HIGH",
    metrics: { stockAvailable: 100, daysOfCover: 80, thresholdDays: 60, ...changes },
  }],
});
const forecast = (id, d7, changes = {}) => ({
  variantId: id, runId: "run", asOf, status: "OK", model: "SES", confidence: "MEDIUM", updatedAt: finishedAt,
  result: { nextDayForecast: { status: "OK", policy: "next-day-v1", totals: { d7, d14: d7 * 2, d28: d7 * 4 } } },
  ...changes,
});
function setup() {
  calls = [];
  outlook = {
    state: "READY", ruleFresh: true, forecastReady: true, warnings: [],
    latestRun: { dataAsOf: "2026-04-26", finishedAt },
    items: [],
    forecastContext: { today: "2026-04-27", latest: {
      id: "run", status: "SUCCEEDED", dataAsOf: asOf, finishedAt,
      summary: { publicationVersion: 1, forecastStatus: "READY" },
    }, forecasts: [], sales: [] },
  };
}
function add(id, d7, sold30 = 30, metric = {}) {
  outlook.items.push(signal(id, metric));
  outlook.forecastContext.forecasts.push(forecast(id, d7));
  outlook.forecastContext.sales.push({ variantId: id, _sum: { unitsSold: sold30 } });
}

test("compares unrounded 7-day forecast and gross 30-day sales, inclusive of the 10% boundary", async () => {
  setup();
  add("equal", 6.3, 30, { daysOfCover: 120 });
  add("below", 6.300001);
  add("above", 6.299999, 30, { daysOfCover: 90, possibleStockoutBias: true });
  add("stale", 1); outlook.items.at(-1).signals[0].current = false;
  const { evidence } = await answerOverstockForecast("tenant");
  assert.deepEqual(evidence.items.map((item) => item.variantId), ["equal", "above"]);
  assert.equal(evidence.items[0].dropPercent, 10);
  assert.equal(evidence.items[1].possibleStockoutBias, true);
  assert.equal(evidence.state, "ready");
  assert.equal(evidence.totalSku, 2);
  assert.deepEqual(evidence.salesPeriod, { from: "2026-03-28", to: "2026-04-26" });
  assert.deepEqual(evidence.forecastPeriod, { from: "2026-04-28", to: "2026-05-04" });
  assert.deepEqual(calls, [["tenant", {}, { all: true, includeForecastComparison: true }]]);
});

test("reports missing, stale, late and incomplete forecasts without claiming a complete empty result", async () => {
  setup();
  add("missing", 1); outlook.forecastContext.forecasts = [];
  add("wrong-run", 1); outlook.forecastContext.forecasts.at(-1).runId = "old";
  add("late", 1); outlook.forecastContext.forecasts.at(-1).updatedAt = new Date("2026-04-27T17:00:00Z");
  add("short", 1); outlook.forecastContext.forecasts.at(-1).status = "INSUFFICIENT_DATA";
  add("zero", 1, 0);
  add("bad-metrics", 1, 30, { stockAvailable: null });
  const result = await answerOverstockForecast("tenant");
  assert.equal(result.evidence.state, "partial");
  assert.equal(result.evidence.skippedSku, 6);
  assert.equal(result.evidence.totalSku, 0);
  outlook.forecastReady = false;
  const unavailable = await answerOverstockForecast("tenant");
  assert.equal(unavailable.evidence.state, "unavailable");
  assert.equal(unavailable.evidence.totalSku, null);
  assert.equal(unavailable.evidence.forecastPeriod, null);
  setup(); outlook.warnings = null;
  assert.equal((await answerOverstockForecast("tenant")).evidence.state, "partial");
});

test("counts all matches before displaying ten and rejects corrupt forecasts", async () => {
  setup();
  for (let i = 0; i < 12; i++) add(`v${i}`, 2, 30, { daysOfCover: 70 + i });
  let result = await answerOverstockForecast("tenant");
  assert.equal(result.evidence.totalSku, 12);
  assert.equal(result.evidence.items.length, 10);
  assert.equal(result.evidence.items[0].variantId, "v11");
  outlook.forecastContext.forecasts[0].result.nextDayForecast.totals.d7 = -1;
  await assert.rejects(answerOverstockForecast("tenant"), /Tổng dự báo không hợp lệ/);
});
