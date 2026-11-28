const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
const { parseComparison } = require("../src/modules/assistant/comparison-question");

const request = { kind: "comparison", metric: "netRevenue", period: "this_week", subjectType: "store" };
const atBoundary = new Date("2024-03-03T17:30:00Z");

test("resolves relative periods in Vietnam time, including week and leap-month boundaries", () => {
  const parse = (period) => parseComparison({ ...request, period }, "Doanh thu?", atBoundary).comparison;
  assert.deepEqual({ from: parse("this_week").from, to: parse("this_week").to }, { from: "2024-03-04", to: "2024-03-04" });
  assert.deepEqual({ from: parse("last_week").from, to: parse("last_week").to }, { from: "2024-02-26", to: "2024-03-03" });
  assert.deepEqual({ from: parse("last_month").from, to: parse("last_month").to }, { from: "2024-02-01", to: "2024-02-29" });
  assert.deepEqual({ from: parse("last_7_days").from, to: parse("last_7_days").to }, { from: "2024-02-26", to: "2024-03-03" });
});

test("requires explicit dates and subjects from the question and validates the provider output", () => {
  const dates = { ...request, period: "dates", from: "2024-02-01", to: "2024-02-29", subjectType: "sku", subject: "ABC-1" };
  const question = "Doanh thu mã ABC-1 từ 2024-02-01 đến 2024-02-29 so với kỳ trước?";
  assert.deepEqual(parseComparison(dates, question, atBoundary).comparison, {
    metric: "netRevenue", from: "2024-02-01", to: "2024-02-29", subjectType: "sku", subject: "ABC-1",
  });
  assert.throws(() => parseComparison({ ...dates, subject: "ABC-2" }, question, atBoundary));
  assert.throws(() => parseComparison({ ...dates, from: "2024-01-01" }, question, atBoundary));
  assert.throws(() => parseComparison({ ...dates, from: "2023-01-01" }, `${question} 2023-01-01`, atBoundary));
  assert.throws(() => parseComparison({ ...dates, to: "2024-03-05" }, `${question} 2024-03-05`, atBoundary));
  assert.throws(() => parseComparison({ ...request, period: "this_week", extra: true }, question, atBoundary));
  assert.throws(() => parseComparison({ kind: "clarify_comparison", missing: "toString" }, question, atBoundary));
  assert.match(parseComparison({ kind: "clarify_comparison", missing: "period" }, question, atBoundary).clarification, /khoảng thời gian/);
});
