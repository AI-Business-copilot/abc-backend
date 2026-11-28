const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

function mock(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const period = { from: "2026-04-20", to: "2026-04-26" };
const ids = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-00000000000${index + 1}`);
const warnings = { excludedSaleItems: 0, excludedReturnItems: 0, missingReturnCostLinks: 0 };
let sales = [20, 19, 18, 17, 16, 15];
let priorSales = [10, 0, 30, 17, 25, 99];
let omittedSales = [];
let state = "ready";
let salesQueries = [];
let outlookQueries = [];
let extraOutlook = [];
let restocks = {};
let lotQueries = 0;
let lots = [{ variantId: ids[0], lotItemId: "lot", lotNumber: "L1", expirationDate: "2026-04-30", status: "QUARANTINED", alertDays: 30, quantity: 8, damaged: 2 }];
mock("../src/shared/dates/date-range", { ...require("../src/shared/dates/date-range"), completedDaysRange: () => period });
mock("../src/modules/business-data/product-performance.service", { getProductPerformance: async (businessId, query) => {
  salesQueries.push({ businessId, query });
  const end = new Date(`${query.from}T00:00:00Z`); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6);
  return { asOf: new Date("2026-04-27T00:00:00Z"), warnings: { ...warnings },
    ranges: { current: { ...query, dayCount: 7 }, previous: { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10), dayCount: 7 } }, items: [{
    name: "Synthetic product", variants: ids.map((id, index) => ({ id, sku: `S${index}`, current: { unitsSold: sales[index] }, previous: { unitsSold: priorSales[index] } })).filter((item) => !omittedSales.includes(item.id)),
  }] };
} });
mock("../src/modules/ai-insights/inventory-outlook.service", { inventoryOutlook: async (businessId, query, options) => {
  outlookQueries.push({ businessId, query, options });
  return {
    state: "READY", ruleFresh: state !== "stale", forecastReady: state !== "forecast",
    warnings: state === "partial" ? null : [],
    latestRun: { dataAsOf: "2026-04-26", finishedAt: new Date("2026-04-27T00:00:00Z") },
    items: [
      { variantId: ids[0], signals: [
        { type: "STOCKOUT_RISK", current: true, severity: "HIGH", metrics: { stockoutDate: "2026-04-30" } },
        { type: "OVERSTOCK", current: true, metrics: { stockAvailable: 100, daysOfCover: 80, thresholdDays: 60 } },
      ] },
      { variantId: ids[5], signals: [
        { type: "STOCKOUT_RISK", current: true, severity: "CRITICAL", metrics: {} },
        { type: "OVERSTOCK", current: true, metrics: { stockAvailable: 100, daysOfCover: 80, thresholdDays: 60 } },
      ] }, ...extraOutlook,
    ].map((item) => ({ ...item, replenishment: restocks[item.variantId] })),
  };
} });
mock("../src/shared/infrastructure/database/prisma.client", { prisma: {
  $transaction: async (fn) => {
    let count = 0;
    return fn({ $queryRaw: async () => count++ === 0
      ? [{ asOf: new Date("2026-04-27T00:00:00Z"), today: "2026-04-27" }]
      : (lotQueries++, lots),
    });
  },
} });

const { answerSkuQuestion } = require("../src/modules/assistant/sku-analysis.service");
const { answerTopSellerInventory } = require("../src/modules/assistant/top-seller-inventory.service");
const { answerComposableSkuQuestion, answerSkuPeriodChange, hasPreviousSkuQuery, isComposableSkuKind } = require("../src/modules/assistant/sku-query.service");
const { answerPreviousNearExpiry } = require("../src/modules/assistant/previous-near-expiry.service");
const { hasPreviousSkuList } = require("../src/modules/assistant/previous-restock.service");
const { answerSkuComparison, hasComparableRanking } = require("../src/modules/assistant/sku-comparison.service");

async function legacy(kind) {
  return kind === "top_sellers" || kind === "top_sellers_stockout"
    ? answerSkuQuestion("tenant", kind)
    : answerTopSellerInventory("tenant", kind);
}

test("composes the existing ranking and filters without changing their results", async () => {
  sales = [20, 19, 18, 17, 16, 15]; state = "ready";
  for (const [kind, filter] of [
    ["top_sellers", null],
    ["top_sellers_stockout", { condition: "stockout_risk", severities: ["HIGH", "CRITICAL"] }],
    ["top_sellers_overstock", { condition: "overstock" }],
    ["top_sellers_near_expiry", { condition: "near_expiry", window: "lot_warning", includeExpired: false }],
  ]) {
    salesQueries = []; outlookQueries = [];
    const expected = await legacy(kind);
    const actual = await answerComposableSkuQuestion("tenant", kind);
    const { query, ...evidence } = actual.evidence;
    assert.deepEqual({ text: actual.text, evidence }, expected);
    assert.deepEqual(query, {
      version: 1, entity: "sku", rank: { metric: "units_sold_before_returns", period, limit: 5 }, filter,
    });
    assert.deepEqual(salesQueries[1], { businessId: "tenant", query: { ...period, all: "true" } });
    if (outlookQueries.length) assert.deepEqual(outlookQueries[1].options.variantIds, ids.slice(0, 5));
    if (filter) assert.ok(!actual.evidence.items.some((item) => item.variantId === ids[5]));
  }
  assert.equal(isComposableSkuKind("previous_stockout"), false);
  assert.equal(isComposableSkuKind("unsupported"), false);
});

test("preserves empty, unavailable and partial outcomes", async () => {
  sales = [0, 0, 0, 0, 0, 0]; state = "ready";
  const empty = await answerComposableSkuQuestion("tenant", "top_sellers_stockout");
  assert.equal(empty.evidence.rankingCount, 0);
  assert.match(empty.text, /Không có mã hàng/);

  sales = [20, 19, 18, 17, 16, 15]; state = "stale";
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_stockout")).evidence.riskState, "unavailable");
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_overstock")).evidence.state, "unavailable");
  state = "forecast";
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_stockout")).evidence.riskState, "unavailable");
  state = "partial";
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_overstock")).evidence.state, "partial");
});

test("rejects unknown analysis rather than silently ranking products", async () => {
  salesQueries = [];
  await assert.rejects(answerComposableSkuQuestion("tenant", "unknown"), /Unsupported composable SKU question/);
  assert.equal(salesQueries.length, 0);
});

test("intersects both conditions after ranking, preserves order and lot details", async () => {
  sales = [20, 19, 18, 17, 16, 15]; state = "ready"; outlookQueries = [];
  extraOutlook = [{ variantId: ids[1], signals: [{ type: "OVERSTOCK", current: true, metrics: { stockAvailable: 70, daysOfCover: 70, thresholdDays: 60 } }] }];
  lots = [
    ...Array.from({ length: 6 }, (_, index) => ({ variantId: ids[0], lotItemId: `lot${index}`, lotNumber: `L${index}`, expirationDate: "2026-04-30", status: "QUARANTINED", alertDays: 30, quantity: 8, damaged: 2 })),
    { variantId: ids[2], lotItemId: "expiry-only", lotNumber: "L", expirationDate: "2026-04-30", status: "ACTIVE", alertDays: 30, quantity: 3, damaged: 0 },
    { variantId: ids[5], lotItemId: "outside-top", lotNumber: "L", expirationDate: "2026-04-30", status: "ACTIVE", alertDays: 30, quantity: 3, damaged: 0 },
  ];
  const { evidence } = await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["near_expiry", "overstock"]);
  assert.deepEqual(outlookQueries[0].options.variantIds, ids.slice(0, 5));
  assert.deepEqual(evidence.items.map((row) => row.variantId), [ids[0]]);
  assert.equal(evidence.rankingCount, 5);
  assert.equal(evidence.totalSku, 1);
  assert.equal(evidence.items[0].stockAvailable, 100);
  assert.equal(evidence.items[0].totalLots, 6);
  assert.equal(evidence.items[0].lots.length, 5);
  assert.equal(evidence.items[0].lots[0].status, "QUARANTINED");
  assert.deepEqual(evidence.query.filters.map((filter) => filter.condition), ["overstock", "near_expiry"]);
  assert.equal(evidence.query.version, 2);
  assert.equal(evidence.inventoryAsOf, "2026-04-27T00:00:00.000Z");
  assert.equal(evidence.dataAsOf, "2026-04-26");
  extraOutlook = [];
});

test("reports incomplete, unavailable and empty composed results without inventing matches", async () => {
  sales = [20, 19, 18, 17, 16, 15]; extraOutlook = []; lots = [];
  state = "ready";
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["overstock", "near_expiry"])).evidence.totalSku, 0);
  state = "stale";
  const unavailable = await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["overstock", "near_expiry"]);
  assert.equal(unavailable.evidence.state, "unavailable");
  assert.equal(unavailable.evidence.totalSku, null);
  assert.equal(unavailable.evidence.inventoryAsOf, null);
  state = "partial";
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["overstock", "near_expiry"])).evidence.state, "partial");
  state = "ready"; warnings.excludedSaleItems = 1;
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["overstock", "near_expiry"])).evidence.state, "partial");
  warnings.excludedSaleItems = 0;
  extraOutlook = [{ variantId: ids[1], signals: [{ type: "OVERSTOCK", current: true, metrics: {} }] }];
  const missingMetrics = await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["overstock", "near_expiry"]);
  assert.equal(missingMetrics.evidence.state, "partial");
  assert.equal(missingMetrics.evidence.skippedSku, 1);
  extraOutlook = []; sales = [0, 0, 0, 0, 0, 0];
  const empty = await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["overstock", "near_expiry"]);
  assert.equal(empty.evidence.rankingCount, 0);
  assert.equal(empty.evidence.totalSku, 0);
});

test("filters pending current restock after ranking and keeps sales order and cautions", async () => {
  sales = [20, 19, 18, 17, 16, 15]; state = "ready"; outlookQueries = [];
  extraOutlook = [
    { variantId: ids[1], signals: [{ type: "EXPIRATION_RISK", current: true }] },
    { variantId: ids[2], signals: [] }, { variantId: ids[3], signals: [] },
  ];
  const suggestion = (urgency, overrides = {}) => ({ status: "PENDING", current: true, urgency,
    orderByDate: null, stockoutDate: null, supplierName: null, suggestedQty: 4, ...overrides });
  restocks = {
    [ids[0]]: suggestion("LOW"), [ids[1]]: suggestion("CRITICAL"),
    [ids[2]]: suggestion("HIGH", { current: false }), [ids[3]]: suggestion("HIGH", { status: "ORDERED" }),
    [ids[5]]: suggestion("CRITICAL"),
  };
  try {
    const result = await answerComposableSkuQuestion("tenant", "top_sellers_restock");
    const evidence = result.evidence;
    assert.deepEqual(outlookQueries[0], { businessId: "tenant", query: {}, options: { variantIds: ids.slice(0, 5), all: true } });
    assert.deepEqual(evidence.items.map((row) => [row.variantId, row.unitsSold]), [[ids[0], 20], [ids[1], 19]]);
    assert.deepEqual(evidence.items[1].cautions, ["EXPIRATION_RISK"]);
    assert.equal(evidence.sourceCount, 5);
    assert.equal(evidence.totalSku, 2);
    assert.deepEqual(evidence.query.filter, { condition: "pending_restock" });
    assert.equal(hasPreviousSkuList(evidence), true);
    const prior = { ...evidence, analysis: "top_sellers_restock" };
    assert.equal(hasPreviousSkuQuery(prior), true);
    sales = [15, 16, 17, 18, 19, 20];
    const next = await answerSkuPeriodChange("tenant", prior, "previous_period");
    assert.deepEqual(next.evidence.period, { from: "2026-04-13", to: "2026-04-19" });
    assert.deepEqual(next.evidence.items.map((row) => row.variantId), [ids[5], ids[1]]);
    assert.equal(next.evidence.query.filter.condition, "pending_restock");
  } finally { extraOutlook = []; restocks = {}; }
});

test("reports missing, stale and incomplete restock data separately from an empty match", async () => {
  sales = [20, 19, 18, 17, 16, 15]; extraOutlook = []; restocks = {}; state = "ready";
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_restock")).evidence.totalSku, 0);
  state = "forecast";
  const unavailable = await answerComposableSkuQuestion("tenant", "top_sellers_restock");
  assert.equal(unavailable.evidence.state, "unavailable");
  assert.equal(unavailable.evidence.totalSku, null);
  state = "stale";
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_restock")).evidence.state, "unavailable");
  state = "partial";
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_restock")).evidence.state, "partial");
  state = "ready"; warnings.excludedSaleItems = 1;
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_restock")).evidence.state, "partial");
  warnings.excludedSaleItems = 0; sales = [0, 0, 0, 0, 0, 0];
  const empty = await answerComposableSkuQuestion("tenant", "top_sellers_restock");
  assert.equal(empty.evidence.sourceCount, 0);
  assert.equal(empty.evidence.totalSku, 0);
});

test("composes pending restock and near-expiry after ranking and preserves both contracts", async () => {
  sales = [20, 19, 18, 17, 16, 15]; state = "ready"; outlookQueries = []; lotQueries = 0;
  extraOutlook = [{ variantId: ids[1], signals: [] }, { variantId: ids[2], signals: [] }];
  const suggestion = { status: "PENDING", current: true, urgency: "HIGH", orderByDate: null,
    stockoutDate: null, supplierName: null, suggestedQty: 4 };
  restocks = { [ids[0]]: suggestion, [ids[1]]: suggestion, [ids[5]]: suggestion };
  lots = [
    ...Array.from({ length: 6 }, (_, index) => ({ variantId: ids[0], lotItemId: `lot${index}`, lotNumber: `L${index}`,
      expirationDate: "2026-04-30", status: "QUARANTINED", alertDays: 30, quantity: 8, damaged: 2 })),
    { variantId: ids[2], lotItemId: "expiry-only", lotNumber: "L", expirationDate: "2026-04-30", status: "HEALTHY", alertDays: 30, quantity: 3, damaged: 0 },
    { variantId: ids[5], lotItemId: "outside-top", lotNumber: "L", expirationDate: "2026-04-30", status: "HEALTHY", alertDays: 30, quantity: 3, damaged: 0 },
  ];
  try {
    const result = await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["near_expiry", "pending_restock"]);
    const evidence = result.evidence;
    assert.deepEqual(outlookQueries[0].options.variantIds, ids.slice(0, 5));
    assert.deepEqual(evidence.items.map((row) => row.variantId), [ids[0]]);
    assert.equal(evidence.items[0].suggestedQty, 4);
    assert.equal(evidence.items[0].totalLots, 6);
    assert.equal(evidence.items[0].lots.length, 5);
    assert.equal(evidence.items[0].lots[0].status, "QUARANTINED");
    assert.deepEqual(evidence.query.filters.map((filter) => filter.condition), ["pending_restock", "near_expiry"]);
    assert.equal(evidence.inventoryAsOf, "2026-04-27T00:00:00.000Z");
    assert.equal(evidence.sourceInventoryCaution, true);
    assert.equal(hasPreviousSkuList(evidence), true);
    const prior = { ...evidence, analysis: "top_sellers_composed" };
    assert.equal(hasPreviousSkuQuery(prior), true);
    assert.equal(hasPreviousSkuQuery({ ...prior, query: { ...prior.query, filters: [{ condition: "overstock" }, prior.query.filters[1]] } }), false);
    sales = [15, 16, 17, 18, 19, 20];
    const next = await answerSkuPeriodChange("tenant", prior, "previous_period");
    assert.deepEqual(next.evidence.period, { from: "2026-04-13", to: "2026-04-19" });
    assert.deepEqual(next.evidence.items.map((row) => row.variantId), [ids[5]]);
    assert.equal(next.evidence.query.filters[0].condition, "pending_restock");
  } finally { extraOutlook = []; restocks = {}; lots = []; }
});

test("does not claim an empty combined result when restock data is unavailable or partial", async () => {
  sales = [20, 19, 18, 17, 16, 15]; restocks = {}; extraOutlook = []; lots = [];
  state = "forecast"; lotQueries = 0;
  const unavailable = await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["pending_restock", "near_expiry"]);
  assert.equal(unavailable.evidence.state, "unavailable");
  assert.equal(unavailable.evidence.totalSku, null);
  assert.equal(unavailable.evidence.inventoryAsOf, null);
  assert.equal(lotQueries, 0);
  state = "partial";
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["pending_restock", "near_expiry"])).evidence.state, "partial");
  state = "ready"; warnings.excludedSaleItems = 1;
  assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["pending_restock", "near_expiry"])).evidence.state, "partial");
  warnings.excludedSaleItems = 0;
  const empty = await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["pending_restock", "near_expiry"]);
  assert.equal(empty.evidence.state, "ready");
  assert.equal(empty.evidence.totalSku, 0);
});

test("combines current restock and overstock from one outlook after ranking", async () => {
  sales = [20, 19, 18, 17, 16, 15]; state = "ready"; outlookQueries = [];
  const suggestion = { status: "PENDING", current: true, urgency: "HIGH", orderByDate: null,
    stockoutDate: null, supplierName: null, suggestedQty: 4 };
  restocks = { [ids[0]]: suggestion, [ids[1]]: suggestion, [ids[2]]: suggestion, [ids[5]]: suggestion };
  extraOutlook = [
    { variantId: ids[1], signals: [] },
    { variantId: ids[2], signals: [{ type: "OVERSTOCK", current: true, metrics: { stockAvailable: 50, daysOfCover: null, thresholdDays: 60 } }] },
    { variantId: ids[3], signals: [{ type: "OVERSTOCK", current: true, metrics: { stockAvailable: 50, daysOfCover: 80, thresholdDays: 60 } }] },
  ];
  try {
    const evidence = (await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["overstock", "pending_restock"])).evidence;
    assert.equal(outlookQueries.length, 1);
    assert.deepEqual(outlookQueries[0].options.variantIds, ids.slice(0, 5));
    assert.deepEqual(evidence.items.map((row) => row.variantId), [ids[0]]);
    assert.equal(evidence.items[0].stockAvailable, 100);
    assert.equal(evidence.items[0].suggestedQty, 4);
    assert.equal(evidence.skippedSku, 1);
    assert.equal(evidence.state, "partial");
    assert.equal(evidence.sourceInventoryCaution, true);
    assert.deepEqual(evidence.query.filters.map((filter) => filter.condition), ["pending_restock", "overstock"]);
    assert.equal(hasPreviousSkuList(evidence), true);
    const prior = { ...evidence, analysis: "top_sellers_composed" };
    assert.equal(hasPreviousSkuQuery(prior), true);
    assert.equal(hasPreviousSkuQuery({ ...prior, query: { ...prior.query, filters: [{ condition: "overstock" }, { condition: "near_expiry", window: "lot_warning", includeExpired: false }] } }), false);
    sales = [15, 16, 17, 18, 19, 20];
    const next = await answerSkuPeriodChange("tenant", prior, "previous_period");
    assert.deepEqual(next.evidence.items.map((row) => row.variantId), [ids[5]]);
    assert.deepEqual(next.evidence.query.filters, prior.query.filters);
    state = "forecast";
    const unavailable = await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["pending_restock", "overstock"]);
    assert.equal(unavailable.evidence.state, "unavailable");
    assert.equal(unavailable.evidence.totalSku, null);
    state = "stale";
    assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["pending_restock", "overstock"])).evidence.state, "unavailable");
    state = "partial";
    assert.equal((await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["pending_restock", "overstock"])).evidence.state, "partial");
    state = "ready"; restocks = {};
    const empty = await answerComposableSkuQuestion("tenant", "top_sellers_composed", ["pending_restock", "overstock"]);
    assert.equal(empty.evidence.state, "ready");
    assert.equal(empty.evidence.totalSku, 0);
  } finally { extraOutlook = []; restocks = {}; state = "ready"; }
});

test("rejects unsupported filter combinations before querying", async () => {
  for (const filters of [undefined, [], ["overstock"], ["overstock", "overstock"], ["overstock", "near_expiry", "stockout"], ["overstock", "other"]]) {
    salesQueries = [];
    await assert.rejects(answerComposableSkuQuestion("tenant", "top_sellers_composed", filters), /Unsupported composable SKU filters/);
    assert.equal(salesQueries.length, 0);
  }
});

test("re-runs all compatible queries for the adjacent period, preserving filters rather than the old SKU set", async () => {
  state = "ready"; extraOutlook = [];
  lots = [{ variantId: ids[0], lotItemId: "lot", lotNumber: "L1", expirationDate: "2026-04-30", status: "HEALTHY", alertDays: 30, quantity: 5, damaged: 0 }];
  for (const kind of ["top_sellers", "top_sellers_stockout", "top_sellers_overstock", "top_sellers_near_expiry", "top_sellers_composed"]) {
    sales = [20, 19, 18, 17, 16, 15];
    const first = await answerComposableSkuQuestion("tenant", kind, ["overstock", "near_expiry"]);
    const prior = { ...first.evidence, analysis: kind };
    assert.equal(hasPreviousSkuQuery(prior), true, kind);
    sales = [15, 16, 17, 18, 19, 20]; salesQueries = []; outlookQueries = [];
    const next = await answerSkuPeriodChange("tenant", prior, "previous_period");
    assert.deepEqual(next.evidence.period, { from: "2026-04-13", to: "2026-04-19" });
    assert.equal(next.kind, kind);
    assert.deepEqual(next.evidence.query, { ...prior.query, rank: { ...prior.query.rank, period: next.evidence.period } });
    assert.deepEqual(salesQueries[0], { businessId: "tenant", query: { from: "2026-04-13", to: "2026-04-19", all: "true" } });
    if (kind === "top_sellers") assert.equal(next.evidence.items[0].variantId, ids[5]);
    if (outlookQueries.length) assert.deepEqual(outlookQueries[0].options.variantIds, ids.slice(1).reverse());
    assert.equal(hasPreviousSkuQuery({ ...next.evidence, analysis: next.kind }), true);
  }
});

test("distinguishes calendar last week from adjacent seven days across Vietnam date boundaries", async () => {
  sales = [20, 19, 18, 17, 16, 15];
  const first = await answerComposableSkuQuestion("tenant", "top_sellers");
  const prior = { ...first.evidence, analysis: "top_sellers" };
  const lastWeek = await answerSkuPeriodChange("tenant", prior, "last_week", new Date("2026-05-04T00:30:00+07:00"));
  assert.deepEqual(lastWeek.evidence.period, { from: "2026-04-27", to: "2026-05-03" });
  const adjacent = await answerSkuPeriodChange("tenant", prior, "previous_period");
  assert.deepEqual(adjacent.evidence.period, { from: "2026-04-13", to: "2026-04-19" });
});

test("rejects old or altered query context and invalid period operations", async () => {
  const first = await answerComposableSkuQuestion("tenant", "top_sellers");
  const prior = { ...first.evidence, analysis: "top_sellers" };
  for (const bad of [
    { ...prior, query: undefined },
    { ...prior, type: "sku_stockout_v1" },
    { ...prior, query: { ...prior.query, rank: { ...prior.query.rank, limit: 500 } } },
    { ...prior, query: { ...prior.query, filter: { condition: "overstock" } } },
    { ...prior, period: { from: "2026-02-30", to: "2026-03-08" } },
  ]) {
    assert.equal(hasPreviousSkuQuery(bad), false);
    await assert.rejects(answerSkuPeriodChange("tenant", bad, "previous_period"), /câu hỏi bán chạy/);
  }
  await assert.rejects(answerSkuPeriodChange("tenant", prior, "unsupported"), /không được hỗ trợ/);
});

test("compares the displayed ranking against its adjacent period without re-ranking", async () => {
  sales = [20, 19, 18, 17, 16, 15]; priorSales = [10, 0, 30, 17, 25, 99]; omittedSales = []; warnings.excludedSaleItems = 1;
  const prior = { ...(await answerComposableSkuQuestion("tenant", "top_sellers")).evidence, analysis: "top_sellers" };
  assert.equal(hasComparableRanking(prior), true);
  sales = [2, 1, 50, 17, 0, 100]; omittedSales = [ids[4]]; warnings.excludedSaleItems = 0; salesQueries = [];
  try {
    const result = await answerSkuComparison("tenant", prior);
    assert.deepEqual(salesQueries, [{ businessId: "tenant", query: { ...period, all: "true" } }]);
    assert.deepEqual(result.evidence.items.map((item) => [item.variantId, item.current, item.previous, item.difference]), [
      [ids[0], 2, 10, -8], [ids[1], 1, 0, 1], [ids[2], 50, 30, 20], [ids[3], 17, 17, 0], [ids[4], null, null, null],
    ]);
    assert.deepEqual(result.evidence.ranges.previous, { from: "2026-04-13", to: "2026-04-19", dayCount: 7 });
    assert.equal(result.evidence.sourceWarnings.excludedSaleItems, 1);
    assert.equal(result.evidence.warnings.excludedSaleItems, 0);
    assert.match(result.text, /chưa thể kết luận/);
    assert.match(result.text, /cảnh báo dữ liệu/);
    assert.equal(result.evidence.items.some((item) => item.variantId === ids[5]), false);
  } finally { omittedSales = []; warnings.excludedSaleItems = 0; }
});

test("requires a complete unfiltered, nonempty, valid previous ranking for sales comparison", async () => {
  sales = [20, 19, 18, 17, 16, 15]; omittedSales = [];
  const prior = { ...(await answerComposableSkuQuestion("tenant", "top_sellers")).evidence, analysis: "top_sellers" };
  for (const bad of [null, { ...prior, query: undefined }, { ...prior, items: [] },
    { ...prior, items: [prior.items[0], prior.items[0]] }, { ...prior, analysis: "top_sellers_stockout" },
    { ...prior, warnings: { ...prior.warnings, excludedSaleItems: -1 } },
    { ...prior, items: [{ ...prior.items[0], sku: "" }] },
    { ...prior, items: [{ ...prior.items[0], variantId: "bad" }] }]) {
    assert.equal(hasComparableRanking(bad), false);
    await assert.rejects(answerSkuComparison("tenant", bad), /danh sách bán chạy/);
  }
});

test("compares adjacent seven-day ranges across a year boundary", async () => {
  sales = [20, 19, 18, 17, 16, 15]; priorSales = [10, 0, 30, 17, 25, 99]; omittedSales = [];
  const first = await answerComposableSkuQuestion("tenant", "top_sellers");
  const period = { from: "2026-01-01", to: "2026-01-07" };
  const prior = { ...first.evidence, analysis: "top_sellers", period,
    query: { ...first.evidence.query, rank: { ...first.evidence.query.rank, period } } };
  const result = await answerSkuComparison("tenant", prior);
  assert.deepEqual(result.evidence.ranges.previous, { from: "2025-12-25", to: "2025-12-31", dayCount: 7 });
  const future = { from: "2999-01-01", to: "2999-01-07" };
  assert.equal(hasComparableRanking({ ...prior, period: future, query: { ...prior.query, rank: { ...prior.query.rank, period: future } } }), false);
});

test("filters only previously displayed SKUs for near-expiry lots and propagates context limits", async () => {
  const prior = {
    type: "slow_expiry_v1", state: "partial", totalSku: 7,
    items: [{ variantId: ids[1], sku: "S2", product: "Product 2" }, { variantId: ids[0], sku: "S1", product: "Product 1" }],
  };
  lots = [
    { variantId: ids[5], lotItemId: "outside", lotNumber: "outside", expirationDate: "2026-04-30", status: "HEALTHY", alertDays: 30, quantity: 3, damaged: 0 },
    ...Array.from({ length: 6 }, (_, index) => ({ variantId: ids[0], lotItemId: `l${index}`, lotNumber: `L${index}`, expirationDate: "2026-04-30", status: "QUARANTINED", alertDays: 30, quantity: 8, damaged: 2 })),
  ];
  const { evidence } = await answerPreviousNearExpiry("tenant", prior);
  assert.equal(evidence.sourceCount, 2);
  assert.equal(evidence.sourcePartial, true);
  assert.equal(evidence.sourceTruncated, true);
  assert.equal(evidence.state, "partial");
  assert.deepEqual(evidence.items.map((item) => item.variantId), [ids[0]]);
  assert.equal(evidence.items[0].totalLots, 6);
  assert.equal(evidence.items[0].lots.length, 5);
  assert.equal(evidence.items[0].lots[0].status, "QUARANTINED");
  assert.equal(hasPreviousSkuList(evidence), true);
  lots = [];
  assert.equal((await answerPreviousNearExpiry("tenant", { ...prior, state: "ready", totalSku: 2 })).evidence.totalSku, 0);
  for (const bad of [null, { ...prior, items: [] }, { ...prior, state: "unavailable" }]) {
    await assert.rejects(answerPreviousNearExpiry("tenant", bad), /danh sách mã hàng/);
  }
});
