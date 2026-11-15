require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { attachForecasts, parseForecastResponse } = require("../src/modules/ai-forecast/forecast-client");

const models = ["MEAN_28", "SES", "CROSTON_SBA", "LIGHTGBM"];
function response(requestId = "r", asOf = "2025-01-28", id = "v", days = 28) {
  const amounts = { d7: 7, d14: 21, d28: 63 };
  return {
    request_id: requestId, as_of: asOf, dataset_kind: "synthetic", model_version: "test-model",
    results: [{
      variant_id: id, status: "OK", series_days: days, model: "MEAN_28",
      daily_sigma: 2, segments: { days_1_7: 7, days_8_14: 14, days_15_28: 42 },
      totals: amounts, confidence: null, wape: null, bias: null, active_share: 0.5, stockout_share: 0,
      comparison: models.map((model) => ({ model, totals: amounts, count: 0, mae: null, wape: null, bias: null })),
    }],
  };
}

test("validates response and distributes each forecast segment across its own days", () => {
  const result = parseForecastResponse(response(), "r", "2025-01-28", new Map([["v", 28]])).get("v");
  assert.deepEqual(result.dailyRates, [...Array(7).fill(1), ...Array(7).fill(2), ...Array(14).fill(3)]);
  assert.equal(result.dailySigma, 2);
  assert.equal(result.confidence, null);
});

test("rejects mismatched identifiers, incomplete comparisons and inconsistent totals", () => {
  const wrong = response();
  wrong.results[0].variant_id = "another";
  assert.throws(() => parseForecastResponse(wrong, "r", "2025-01-28", new Map([["v", 28]])), /không hợp lệ/);
  const bad = response();
  bad.results[0].totals.d28 = 5;
  assert.throws(() => parseForecastResponse(bad, "r", "2025-01-28", new Map([["v", 28]])), /không hợp lệ/);
  const duplicate = response();
  duplicate.results[0].comparison[1].model = "MEAN_28";
  assert.throws(() => parseForecastResponse(duplicate, "r", "2025-01-28", new Map([["v", 28]])), /không hợp lệ/);
});

test("short and censored histories remain explicitly unavailable", () => {
  const payload = {
    request_id: "r", as_of: "2025-01-28", dataset_kind: "synthetic", model_version: "test-model",
    results: [
      { variant_id: "a", status: "INSUFFICIENT_DATA", series_days: 0, reason: "SHORT_HISTORY" },
      { variant_id: "b", status: "INSUFFICIENT_DATA", series_days: 28, reason: "CENSORED_HISTORY" },
    ],
  };
  const result = parseForecastResponse(payload, "r", "2025-01-28", new Map([["a", 0], ["b", 28]]));
  assert.equal(result.get("a").reason, "SHORT_HISTORY");
  assert.equal(result.get("b").reason, "CENSORED_HISTORY");
  assert.equal(result.get("b").confidence, null);
});

test("requests Python in batches and sends gross POS history only", async (t) => {
  const oldUrl = process.env.FORECAST_RESEARCH_URL;
  const oldToken = process.env.FORECAST_RESEARCH_TOKEN;
  process.env.FORECAST_RESEARCH_URL = "http://127.0.0.1:8001";
  process.env.FORECAST_RESEARCH_TOKEN = "test-token";
  t.after(() => {
    if (oldUrl === undefined) delete process.env.FORECAST_RESEARCH_URL; else process.env.FORECAST_RESEARCH_URL = oldUrl;
    if (oldToken === undefined) delete process.env.FORECAST_RESEARCH_TOKEN; else process.env.FORECAST_RESEARCH_TOKEN = oldToken;
  });
  let calls = 0;
  t.mock.method(global, "fetch", async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    assert.ok(request.variants.length <= 200);
    assert.equal(request.min_series_days, 28);
    assert.equal(request.variants[0].history[0].date, "2025-01-01");
    assert.equal(request.variants[0].history[0].units_sold, 2);
    const payload = response(request.request_id, request.as_of);
    payload.results = request.variants.map((item) => response(request.request_id, request.as_of, item.variant_id).results[0]);
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  const variants = Array.from({ length: 201 }, (_, i) => ({
    variantId: String(i), ageDays: 28, dailySales: Array(28).fill(1),
    grossDailySales: Array(28).fill(2), stockoutDays: Array(28).fill(false),
  }));
  const result = await attachForecasts({ asOf: "2025-01-28", today: "2025-01-29", variants }, { forecast: { minSeriesDays: 14 } });
  assert.equal(calls, 2);
  assert.equal(result.variants.length, 201);
  assert.equal(result.variants[200].forecast.modelVersion, "test-model");
});

test("reports missing Python configuration without forecasting in Node", async (t) => {
  const oldUrl = process.env.FORECAST_RESEARCH_URL;
  const oldToken = process.env.FORECAST_RESEARCH_TOKEN;
  delete process.env.FORECAST_RESEARCH_URL;
  delete process.env.FORECAST_RESEARCH_TOKEN;
  t.after(() => {
    if (oldUrl !== undefined) process.env.FORECAST_RESEARCH_URL = oldUrl;
    if (oldToken !== undefined) process.env.FORECAST_RESEARCH_TOKEN = oldToken;
  });
  await assert.rejects(attachForecasts({ variants: [{ variantId: "v" }] }, { forecast: { minSeriesDays: 28 } }), /chưa được cấu hình/);
});
