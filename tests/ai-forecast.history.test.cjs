require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateForecast } = require("../src/modules/ai-forecast/forecast-history.service");
const { persistForecasts } = require("../src/modules/ai-forecast/replenishment.service");

const predictions = { 7: 7, 14: 14, 28: 28 };
const issued = new Date("2025-01-02T03:00:00Z");
const sales = Array(28).fill(2);
const flags = Array(28).fill(false);

test("evaluates only complete horizons and marks an already-started first day", () => {
  const result = evaluateForecast("2025-01-01", issued, predictions, "2025-01-02", "2025-01-15", sales, flags);
  assert.equal(result[0].status, "PARTIAL_START");
  assert.equal(result[0].actual, 14);
  assert.equal(result[0].absoluteError, 7);
  assert.equal(result[1].actual, 28);
  assert.equal(result[2].status, "PENDING");
});

test("stockout and unknown stock are not treated as clean evaluation windows", () => {
  const evidence = [...flags];
  evidence[3] = true;
  evidence[10] = null;
  const result = evaluateForecast("2025-01-01", issued, predictions, "2025-01-02", "2025-01-29", sales, evidence);
  assert.equal(result[0].status, "STOCKOUT");
  assert.equal(result[1].status, "UNKNOWN_STOCK");
  assert.equal(result[2].unknownDays, 1);
  assert.equal(result[2].stockoutDays, 1);
});

test("only a forecast issued before the first business day can be marked comparable", () => {
  const result = evaluateForecast("2025-01-01", new Date("2025-01-01T16:59:59Z"), predictions, "2025-01-02", "2025-01-29", sales, flags);
  assert.ok(result.every((item) => item.status === "COMPARABLE"));
});

test("does not invent actuals outside the retained stock history", () => {
  const result = evaluateForecast("2025-01-01", issued, predictions, "2025-01-03", "2025-02-01", sales, flags);
  assert.equal(result[0].status, "OUTSIDE_HISTORY");
  assert.equal(result[0].actual, null);
});

test("records successful forecasts separately while excluding insufficient histories", async () => {
  const saved = [];
  const tx = {
    aiForecast: { deleteMany: async () => {}, createMany: async () => {} },
    aiForecastHistory: { createMany: async (params) => saved.push(params) },
  };
  const make = (status) => ({ status, model: status === "OK" ? "MEAN_28" : null, confidence: null, dailyRate: 1 });
  await persistForecasts(tx, "business", "run", {
    asOf: "2025-01-01",
    variants: [{ variantId: "valid", forecast: make("OK") }, { variantId: "short", forecast: make("INSUFFICIENT_DATA") }],
  });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].data.map((row) => row.variantId), ["valid"]);
  assert.equal(saved[0].skipDuplicates, true);
});
