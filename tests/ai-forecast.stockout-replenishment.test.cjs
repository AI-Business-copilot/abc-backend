require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { arrivalsFrom, projectStockout, assessRisk } = require("../src/modules/ai-forecast/stockout");
const { roundOrderQty, suggestReplenishment } = require("../src/modules/ai-forecast/replenishment");

const slack = { highSlackDays: 7, mediumSlackDays: 14 };

test("stockout before the PO arrives is CRITICAL", () => {
  const arrivals = arrivalsFrom([{ qty: 100, arrivalDate: "2026-01-20" }], "2026-01-10");
  const projection = projectStockout(20, 5, arrivals);
  assert.equal(projection.stockoutOffset, 4);
  const risk = assessRisk(projection, arrivals, 7, slack);
  assert.equal(risk.level, "CRITICAL");
  assert.equal(risk.slackDays, -6);
});

test("an earlier PO that is used up does not hide a later stockout", () => {
  const arrivals = [{ offset: 2, qty: 10 }];
  const projection = projectStockout(10, 5, arrivals);
  assert.equal(projection.stockoutOffset, 4);
  assert.equal(assessRisk(projection, arrivals, 7, slack).level, "CRITICAL");
});

test("overdue PO is assumed to arrive tomorrow", () => {
  assert.equal(arrivalsFrom([{ qty: 5, arrivalDate: "2026-01-01" }], "2026-01-10")[0].offset, 1);
});

test("multiple partially received and overdue orders arrive in chronological order", () => {
  const arrivals = arrivalsFrom([
    { qty: 6, arrivalDate: "2026-01-15" },
    { qty: 3, arrivalDate: "2026-01-08" },
    { qty: 0, arrivalDate: "2026-01-11" },
    { qty: 4, arrivalDate: "2026-01-12" },
  ], "2026-01-10");
  assert.deepEqual(arrivals, [{ offset: 1, qty: 3 }, { offset: 2, qty: 4 }, { offset: 5, qty: 6 }]);
  assert.equal(projectStockout(2, 1, arrivals, 14).stockoutOffset, null);
});

test("later delivery exposes a stockout that an on-time delivery avoids", () => {
  const onTime = arrivalsFrom([{ qty: 20, arrivalDate: "2026-01-12" }], "2026-01-10");
  const late = arrivalsFrom([{ qty: 20, arrivalDate: "2026-01-15" }], "2026-01-10");
  assert.equal(projectStockout(6, 2, onTime, 7).stockoutOffset, null);
  assert.equal(projectStockout(6, 2, late, 7).stockoutOffset, 3);
});

test("stock lasting the horizon has no risk", () => {
  const projection = projectStockout(10000, 5, []);
  assert.equal(projection.stockoutOffset, null);
  assert.equal(assessRisk(projection, [], 7, slack).level, null);
});

test("slack thresholds map to HIGH and MEDIUM", () => {
  const high = assessRisk({ stockoutOffset: 10, firstArrivalOffset: null }, [], 7, slack);
  assert.equal(high.level, "HIGH");
  const medium = assessRisk({ stockoutOffset: 15, firstArrivalOffset: null }, [], 7, slack);
  assert.equal(medium.level, "MEDIUM");
});

test("roundOrderQty honours minimum order and multiples", () => {
  assert.equal(roundOrderQty(13.2, 0, 12), 24);
  assert.equal(roundOrderQty(3, 20, 1), 20);
  assert.equal(roundOrderQty(21, 20, 6), 24);
});

test("stockout projection follows the daily segment rates rather than a flat 28-day mean", () => {
  const rates = [...Array(7).fill(1), ...Array(21).fill(4)];
  assert.equal(projectStockout(10, rates, []).stockoutOffset, 7);
});

test("replenishment uses forecast segments and refuses protection periods beyond 28 days", () => {
  const rates = [...Array(7).fill(1), ...Array(7).fill(2), ...Array(14).fill(3)];
  const variant = {
    variantId: "v", stockAvailable: 1, safetyStockQty: 2, lots: [], incoming: [],
    supply: { leadTimeDays: 7, reviewPeriodDays: 7, minOrderQty: 1, orderMultiple: 1, unitCost: 1 },
    forecast: { status: "OK", dailyRate: 63 / 28, dailyRates: rates, dailySigma: 1, totals: { d14: 21 }, wape: null, confidence: null },
  };
  const settings = { forecast: { serviceLevelPct: 90 }, stockout: slack };
  const result = suggestReplenishment(variant, "2026-01-10", settings);
  assert.equal(result.details.target, 23);
  assert.equal(result.suggestedQty, 22);
  assert.equal(result.confidence, null);
  variant.supply.reviewPeriodDays = 22;
  assert.equal(suggestReplenishment(variant, "2026-01-10", settings), null);
});
