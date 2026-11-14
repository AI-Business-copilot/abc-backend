require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");

const { analyze, nextStatus, scoreFindings } = require("../src/modules/ai-insights/engine.ts");
const { DEFAULT_SETTINGS, resolveSettings } = require("../src/modules/ai-insights/settings.ts");
const { detectLowStock } = require("../src/modules/ai-insights/rules/low-stock.ts");
const { detectSlowMoving } = require("../src/modules/ai-insights/rules/slow-moving.ts");
const { detectDecliningSales } = require("../src/modules/ai-insights/rules/declining-sales.ts");
const { detectOverstock } = require("../src/modules/ai-insights/rules/overstock.ts");
const { detectExpirationRisk } = require("../src/modules/ai-insights/rules/expiration-risk.ts");

const TODAY = "2026-11-14";

function variant(overrides = {}) {
  const dailySales = overrides.dailySales ?? new Array(60).fill(0);
  const last = (n) => dailySales.slice(60 - n).reduce((a, b) => a + b, 0);
  const sold30 = last(30);
  return {
    variantId: "v1",
    sku: "SKU1",
    name: "Product",
    category: "Cat",
    costPrice: 10,
    leadTimeDays: 3,
    safetyStockQty: 0,
    stockAvailable: 0,
    ageDays: 120,
    dailySales,
    sold7: last(7),
    sold14: last(14),
    sold30,
    sold60: last(60),
    avgDaily30: sold30 / 30,
    daysSinceLastSale: sold30 > 0 ? 1 : 100,
    possibleStockoutBias: false,
    lots: [],
    ...overrides,
  };
}
const snap = (...variants) => ({ asOf: "2026-11-13", today: TODAY, variants });
const steady = (perDay) => new Array(60).fill(perDay);

test("low stock: out of stock with demand is critical, healthy stock is ignored", () => {
  const out = detectLowStock(snap(variant({ dailySales: steady(2), stockAvailable: 0 })), DEFAULT_SETTINGS);
  assert.equal(out[0].severity, "CRITICAL");
  assert.equal(out[0].metrics.reorderPoint, 6);

  const ok = detectLowStock(snap(variant({ dailySales: steady(2), stockAvailable: 7 })), DEFAULT_SETTINGS);
  assert.equal(ok.length, 0);

  const below = detectLowStock(snap(variant({ dailySales: steady(2), stockAvailable: 6 })), DEFAULT_SETTINGS);
  assert.equal(below[0].severity, "MEDIUM");
});

test("low stock: no demand and no safety stock is never flagged; safety stock breach is high", () => {
  assert.equal(detectLowStock(snap(variant({ stockAvailable: 0 })), DEFAULT_SETTINGS).length, 0);
  const found = detectLowStock(snap(variant({ safetyStockQty: 5, stockAvailable: 3 })), DEFAULT_SETTINGS);
  assert.equal(found[0].severity, "HIGH");
});

test("slow moving: severity grows with days without sale and value uses cost", () => {
  const found = detectSlowMoving(
    snap(variant({ stockAvailable: 10, daysSinceLastSale: 95, costPrice: 20 })),
    DEFAULT_SETTINGS,
  );
  assert.equal(found[0].severity, "HIGH");
  assert.equal(found[0].valueAtRisk, 200);
  assert.equal(detectSlowMoving(snap(variant({ stockAvailable: 0, daysSinceLastSale: 95 })), DEFAULT_SETTINGS).length, 0);
  assert.equal(detectSlowMoving(snap(variant({ stockAvailable: 5, ageDays: 10, daysSinceLastSale: null })), DEFAULT_SETTINGS).length, 0);
});

test("declining sales: needs a base volume and a big enough drop", () => {
  const drop = [...new Array(46).fill(0), ...new Array(14).fill(0)];
  for (let i = 32; i < 46; i += 1) drop[i] = 2; // previous 14 days: 28 units
  for (let i = 46; i < 60; i += 1) drop[i] = i === 46 ? 8 : 0; // latest: 8 units, -71%
  const found = detectDecliningSales(snap(variant({ dailySales: drop, stockAvailable: 10 })), DEFAULT_SETTINGS);
  assert.equal(found[0].severity, "HIGH");
  assert.equal(found[0].reasonCode, "SALES_DROP");

  const stockedOut = detectDecliningSales(snap(variant({ dailySales: drop, stockAvailable: 0 })), DEFAULT_SETTINGS);
  assert.equal(stockedOut[0].reasonCode, "DECLINE_POSSIBLY_STOCKOUT");

  const small = new Array(60).fill(0);
  small[40] = 4;
  assert.equal(detectDecliningSales(snap(variant({ dailySales: small })), DEFAULT_SETTINGS).length, 0);
  assert.equal(detectDecliningSales(snap(variant({ dailySales: drop, ageDays: 20 })), DEFAULT_SETTINGS).length, 0);
});

test("overstock: ignores products without demand and computes excess against target days", () => {
  assert.equal(detectOverstock(snap(variant({ stockAvailable: 500 })), DEFAULT_SETTINGS).length, 0);
  const found = detectOverstock(snap(variant({ dailySales: steady(1), stockAvailable: 130, costPrice: 10 })), DEFAULT_SETTINGS);
  assert.equal(found[0].severity, "HIGH");
  assert.equal(found[0].metrics.excessQty, 85);
  assert.equal(found[0].valueAtRisk, 850);
  assert.equal(detectOverstock(snap(variant({ dailySales: steady(1), stockAvailable: 60 })), DEFAULT_SETTINGS).length, 0);
});

test("expiration risk: FEFO gives earlier lots first claim on demand", () => {
  const lots = [
    { lotItemId: "l2", lotNumber: "B", expirationDate: "2026-12-14", quantity: 30, alertDaysBefore: 30, status: "WARNING" },
    { lotItemId: "l1", lotNumber: "A", expirationDate: "2026-11-24", quantity: 20, alertDaysBefore: 30, status: "WARNING" },
  ];
  // 1 unit/day: lot A has 10 days -> sells 10 of 20; lot B has 30 days, 10 days of demand already taken -> sells 20 of 30.
  const found = detectExpirationRisk(snap(variant({ dailySales: steady(1), lots })), DEFAULT_SETTINGS);
  const a = found.find((f) => f.lotItemId === "l1");
  const b = found.find((f) => f.lotItemId === "l2");
  assert.equal(a.metrics.atRiskQty, 10);
  assert.equal(a.severity, "HIGH");
  assert.equal(b.metrics.atRiskQty, 10);
  assert.equal(b.severity, "MEDIUM");
});

test("expiration risk: expired stock is critical, unsellable near-expiry is high, fully sellable lot is ignored", () => {
  const lots = [
    { lotItemId: "e", lotNumber: "E", expirationDate: "2026-11-10", quantity: 3, alertDaysBefore: 30, status: "UNUSABLE" },
    { lotItemId: "u", lotNumber: "U", expirationDate: "2026-11-18", quantity: 4, alertDaysBefore: 30, status: "UNUSABLE" },
    { lotItemId: "ok", lotNumber: "OK", expirationDate: "2026-12-20", quantity: 5, alertDaysBefore: 30, status: "WARNING" },
  ];
  const found = detectExpirationRisk(snap(variant({ dailySales: steady(5), lots })), DEFAULT_SETTINGS);
  assert.equal(found.find((f) => f.lotItemId === "e").severity, "CRITICAL");
  assert.equal(found.find((f) => f.lotItemId === "e").reasonCode, "EXPIRED_IN_STOCK");
  assert.equal(found.find((f) => f.lotItemId === "u").reasonCode, "UNSELLABLE_NEAR_EXPIRY");
  assert.equal(found.some((f) => f.lotItemId === "ok"), false);
});

test("expiration risk: without demand only lots inside the alert window are flagged", () => {
  const lots = [
    { lotItemId: "near", lotNumber: "N", expirationDate: "2026-12-01", quantity: 5, alertDaysBefore: 30, status: "WARNING" },
    { lotItemId: "far", lotNumber: "F", expirationDate: "2027-03-01", quantity: 5, alertDaysBefore: 30, status: "HEALTHY" },
  ];
  const found = detectExpirationRisk(snap(variant({ lots })), DEFAULT_SETTINGS);
  assert.deepEqual(found.map((f) => f.lotItemId), ["near"]);
});

test("analyze: new products skip demand rules but still get expiry checks, and warnings are reported", () => {
  const lots = [{ lotItemId: "e", lotNumber: "E", expirationDate: "2026-11-01", quantity: 2, alertDaysBefore: 30, status: "UNUSABLE" }];
  const result = analyze(snap(variant({ ageDays: 3, stockAvailable: 50, lots, dailySales: steady(1) })), DEFAULT_SETTINGS);
  assert.deepEqual(result.findings.map((f) => f.type), ["EXPIRATION_RISK"]);
  assert.ok(result.warnings.some((w) => w.code === "INSUFFICIENT_HISTORY"));
  assert.equal(result.capital.totalCapital, 0);
});

test("scoring ranks by severity then value, and fingerprints are stable", () => {
  const scored = scoreFindings([
    { type: "OVERSTOCK", variantId: "a", lotItemId: null, severity: "HIGH", valueAtRisk: 100, metrics: {}, reasonCode: "x", suggestedAction: "y" },
    { type: "OVERSTOCK", variantId: "b", lotItemId: null, severity: "HIGH", valueAtRisk: 50, metrics: {}, reasonCode: "x", suggestedAction: "y" },
    { type: "LOW_STOCK", variantId: "c", lotItemId: null, severity: "CRITICAL", valueAtRisk: null, metrics: {}, reasonCode: "x", suggestedAction: "y" },
  ]);
  assert.deepEqual(scored.map((f) => f.priorityScore), [100, 85, 100]);
  assert.equal(scored[0].fingerprint, "OVERSTOCK:a:");
});

test("lifecycle: handled insights stay handled unless snooze ends or severity worsens", () => {
  assert.equal(nextStatus({ status: "DISMISSED", severity: "MEDIUM", snoozeUntil: null }, "MEDIUM", TODAY), "DISMISSED");
  assert.equal(nextStatus({ status: "DISMISSED", severity: "MEDIUM", snoozeUntil: "2026-11-20" }, "MEDIUM", TODAY), "DISMISSED");
  assert.equal(nextStatus({ status: "DISMISSED", severity: "MEDIUM", snoozeUntil: "2026-11-14" }, "MEDIUM", TODAY), "OPEN");
  assert.equal(nextStatus({ status: "DISMISSED", severity: "MEDIUM", snoozeUntil: null }, "HIGH", TODAY), "OPEN");
  assert.equal(nextStatus({ status: "ACKNOWLEDGED", severity: "HIGH", snoozeUntil: null }, "HIGH", TODAY), "ACKNOWLEDGED");
  assert.equal(nextStatus({ status: "RESOLVED", severity: "HIGH", snoozeUntil: null }, "LOW", TODAY), "OPEN");
});

test("settings: defaults merge, out-of-range and inconsistent values are rejected", () => {
  assert.equal(resolveSettings({ overstock: { thresholdDays: 90 } }).overstock.thresholdDays, 90);
  assert.equal(resolveSettings({}).declining.periodDays, 14);
  assert.throws(() => resolveSettings({ minHistoryDays: 0 }), /minHistoryDays/);
  assert.throws(() => resolveSettings({ declining: { periodDays: "7" } }), /periodDays/);
  assert.throws(() => resolveSettings({ declining: { mediumPct: 60, highPct: 40 } }), /highPct/);
  assert.throws(() => resolveSettings({ overstock: { thresholdDays: 30, targetDays: 45 } }), /targetDays/);
  assert.throws(() => resolveSettings([]), /object/);
});
