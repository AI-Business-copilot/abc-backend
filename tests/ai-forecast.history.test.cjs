require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateForecast, evaluateForecastSegments, evaluateNextDayForecast, forecastAvailableAt, forecastHistoryInTransaction } = require("../src/modules/ai-forecast/forecast-history.service");
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

test("compares later segments against their exact dates without dividing or extending the forecast", () => {
  const totals = { 7: 7, 14: 21, 28: 63 };
  const actualSales = [...Array(7).fill(100), ...Array(7).fill(2), ...Array(14).fill(3)];
  const result = evaluateForecastSegments("2025-01-01", issued, totals, "2025-01-02", "2025-01-29", actualSales, flags);
  assert.deepEqual(result.map((row) => [row.start, row.end, row.days, row.predicted, row.actual, row.status]), [
    ["2025-01-09", "2025-01-15", 7, 14, 14, "COMPARABLE"],
    ["2025-01-16", "2025-01-29", 14, 42, 42, "COMPARABLE"],
  ]);
});

test("later segment comparisons honor publication time, completion and stock evidence", () => {
  const asOf = "2025-01-01";
  const late = new Date("2025-01-08T17:00:00Z");
  assert.equal(evaluateForecastSegments(asOf, late, predictions, "2025-01-02", "2025-01-29", sales, flags)[0].status, "PARTIAL_START");
  assert.equal(evaluateForecastSegments(asOf, null, predictions, "2025-01-02", "2025-01-29", sales, flags)[0].status, "PUBLICATION_UNKNOWN");
  assert.equal(evaluateForecastSegments(asOf, issued, predictions, "2025-01-02", "2025-01-14", sales, flags)[0].status, "PENDING");
  assert.equal(evaluateForecastSegments(asOf, issued, predictions, "2025-01-10", "2025-01-29", sales, flags)[0].status, "OUTSIDE_HISTORY");
  const evidence = [...flags];
  evidence[7] = true;
  evidence[14] = null;
  assert.deepEqual(evaluateForecastSegments(asOf, issued, predictions, "2025-01-02", "2025-01-29", sales, evidence).map((row) => row.status), ["STOCKOUT", "UNKNOWN_STOCK"]);
});

test("next-day forecast uses day 2 through 29 and rejects late publication", () => {
  const values = [999, ...Array(28).fill(2)];
  const evidence = Array(29).fill(false);
  const result = evaluateNextDayForecast("2025-01-01", issued, predictions, "2025-01-02", "2025-01-30", values, evidence);
  assert.deepEqual(result.map((row) => [row.start, row.end, row.actual, row.status]), [
    ["2025-01-03", "2025-01-09", 14, "COMPARABLE"],
    ["2025-01-03", "2025-01-16", 28, "COMPARABLE"],
    ["2025-01-03", "2025-01-30", 56, "COMPARABLE"],
  ]);
  const boundary = new Date("2025-01-02T17:00:00Z");
  assert.equal(evaluateNextDayForecast("2025-01-01", boundary, predictions, "2025-01-02", "2025-01-30", values, evidence)[0].status, "PARTIAL_START");
  evidence[28] = null;
  const partial = evaluateNextDayForecast("2025-01-01", issued, predictions, "2025-01-02", "2025-01-29", values, evidence);
  assert.equal(partial[2].status, "PENDING");
  assert.equal(evaluateNextDayForecast("2025-01-01", issued, predictions, "2025-01-02", "2025-01-30", values, evidence)[2].status, "UNKNOWN_STOCK");
});

test("uses the later completion time, or reports missing completion time", () => {
  const finished = new Date("2025-01-09T01:00:00Z");
  assert.equal(forecastAvailableAt(issued, finished), finished);
  assert.equal(forecastAvailableAt(finished, issued), finished);
  assert.equal(forecastAvailableAt(issued, null), null);
  assert.equal(evaluateForecast("2025-01-01", null, predictions, "2025-01-02", "2025-01-29", sales, flags)[0].status, "PUBLICATION_UNKNOWN");
});

test("history response uses run completion and exposes both later segment evaluations", async () => {
  const rows = [
    [{ id: "history", runId: "run", asOf: new Date("2025-01-01T00:00:00Z"), issuedAt: issued,
       finishedAt: new Date("2025-01-09T01:00:00Z"), result: { totals: { d7: 7, d14: 21, d28: 63 } } }],
    [{ total: 5, count: 1, firstDay: "2025-01-02", invalid: 0 }],
    [{ quantity: 5 }],
    [],
    [],
  ];
  const tx = { $queryRaw: async () => rows.shift() };
  const result = await forecastHistoryInTransaction(tx, "business", "variant", "2025-02-01");
  assert.equal(result.items[0].evaluations[0].status, "PARTIAL_START");
  assert.deepEqual(result.items[0].segmentEvaluations.map((row) => [row.predicted, row.status]), [
    [14, "PARTIAL_START"], [42, "COMPARABLE"],
  ]);
  assert.deepEqual(result.items[0].nextDayEvaluation, { status: "UNAVAILABLE", reason: "NOT_RECORDED" });
});

test("history evaluates only the shifted forecast stored with the original snapshot", async () => {
  const rows = [
    [{ id: "history", runId: "run", asOf: new Date("2025-01-01T00:00:00Z"), issuedAt: issued,
       finishedAt: issued, result: { totals: { d7: 7, d14: 21, d28: 63 },
         nextDayForecast: { status: "OK", policy: "next-day-v1", totals: { d7: 8, d14: 22, d28: 64 } } } }],
    [{ total: 5, count: 1, firstDay: "2025-01-02", invalid: 0 }], [{ quantity: 5 }], [], [],
  ];
  const result = await forecastHistoryInTransaction({ $queryRaw: async () => rows.shift() }, "business", "variant", "2025-02-01");
  assert.deepEqual(result.items[0].nextDayEvaluation.evaluations.map((row) => [row.predicted, row.status]), [
    [8, "COMPARABLE"], [22, "COMPARABLE"], [64, "COMPARABLE"],
  ]);
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
