const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

const modulePath = require.resolve("../src/modules/ai-insights/inventory-outlook.service");
let outlook;
let calls;
require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: {
  inventoryOutlook: async (...args) => { calls.push(args); return outlook; },
} };
const { answerPreviousRestock, hasPreviousSkuList } = require("../src/modules/assistant/previous-restock.service");
const { answerPreviousItemCover, positionInQuestion } = require("../src/modules/assistant/previous-item-cover.service");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (n) => ({ variantId: id(n), sku: `S${n}`, product: `Product ${n}` });
const warnings = { excludedSaleItems: 0, excludedReturnItems: 0, missingReturnCostLinks: 0 };
const previous = (type, items = [item(1), item(2)]) => ({
  type, items, warnings, riskState: "ready", state: "ready", totalSku: items.length,
});
const source = (n, urgency, date, overrides = {}) => ({
  variantId: id(n), signals: [],
  replenishment: { status: "PENDING", current: true, urgency, orderByDate: date, stockoutDate: null,
    supplierName: null, suggestedQty: 4, ...overrides },
});
const setup = () => {
  calls = [];
  outlook = { state: "READY", ruleFresh: true, forecastReady: true, warnings: [],
    latestRun: { dataAsOf: "2026-04-26", finishedAt: new Date("2026-04-27T00:00:00Z") }, items: [] };
};

test("accepts only supported displayed nonempty SKU lists and rejects malformed context", () => {
  for (const type of ["top_sellers_v1", "sku_stockout_v1", "top_sellers_overstock_v1", "top_sellers_near_expiry_v1", "top_sellers_overstock_near_expiry_v1", "slow_expiry_v1", "profit_restock_v1", "overstock_forecast_v1", "previous_restock_v1"]) {
    assert.equal(hasPreviousSkuList(previous(type)), true, type);
  }
  assert.equal(hasPreviousSkuList(previous("unknown")), false);
  assert.equal(hasPreviousSkuList(previous("top_sellers_v1", [])), false);
  assert.equal(hasPreviousSkuList(previous("top_sellers_v1", [item(1), item(1)])), false);
  assert.equal(hasPreviousSkuList(previous("top_sellers_v1", Array.from({ length: 6 }, (_, i) => item(i)))), false);
  assert.equal(hasPreviousSkuList(previous("slow_expiry_v1", [{ ...item(1), variantId: "bad" }])), false);
  assert.equal(hasPreviousSkuList({ ...previous("sku_stockout_v1"), riskState: "unavailable" }), false);
  assert.equal(hasPreviousSkuList({ ...previous("slow_expiry_v1"), state: "unavailable" }), false);
  assert.equal(hasPreviousSkuList({ ...previous("profit_restock_v1"), totalSku: 1 }), false);
});

test("preserves incompleteness and inventory cautions for a composed list", async () => {
  setup();
  const prior = { ...previous("top_sellers_overstock_near_expiry_v1"), state: "partial" };
  outlook.items = [source(1, "HIGH", null)];
  const { evidence } = await answerPreviousRestock("tenant", prior);
  assert.equal(evidence.sourceInventoryCaution, true);
  assert.equal(evidence.sourcePartial, true);
  assert.equal(evidence.state, "partial");
  assert.deepEqual(calls[0][2].variantIds, prior.items.map((row) => row.variantId));
});

test("filters to displayed IDs, pending current suggestions and sorts urgency then date", async () => {
  setup();
  const prior = previous("slow_expiry_v1", [item(1), item(2), item(3), item(4), item(5)]);
  prior.totalSku = 15; prior.state = "partial";
  outlook.items = [
    source(1, "HIGH", "2026-05-02"), source(2, "CRITICAL", null),
    { ...source(3, "HIGH", "2026-05-01"), signals: [{ type: "EXPIRATION_RISK", current: true }, { type: "EXPIRATION_RISK", current: true }, { type: "OVERSTOCK", current: false }] },
    source(4, "CRITICAL", "2026-04-29", { current: false }),
    source(5, "CRITICAL", "2026-04-29", { status: "ORDERED" }),
  ];
  const { evidence } = await answerPreviousRestock("tenant", prior);
  assert.deepEqual(calls, [["tenant", {}, { variantIds: prior.items.map((row) => row.variantId), all: true }]]);
  assert.deepEqual(evidence.items.map((row) => row.variantId), [id(2), id(3), id(1)]);
  assert.deepEqual(evidence.items[1].cautions, ["EXPIRATION_RISK"]);
  assert.equal(evidence.sourceCount, 5);
  assert.equal(evidence.totalSku, 3);
  assert.equal(evidence.sourceTruncated, true);
  assert.equal(evidence.sourceInventoryCaution, true);
  assert.equal(evidence.state, "partial");
  assert.equal(hasPreviousSkuList(evidence), true);
});

test("reports stale data, partial warning metadata and genuinely empty suggestions separately", async () => {
  setup();
  const prior = previous("top_sellers_v1");
  outlook.items = [source(1, "LOW", null, { status: "DISMISSED" })];
  const empty = await answerPreviousRestock("tenant", prior);
  assert.equal(empty.evidence.state, "ready");
  assert.equal(empty.evidence.totalSku, 0);
  assert.match(empty.text, /chưa tìm thấy/i);
  outlook.warnings = null;
  assert.equal((await answerPreviousRestock("tenant", prior)).evidence.state, "partial");
  outlook.forecastReady = false;
  const unavailable = await answerPreviousRestock("tenant", prior);
  assert.equal(unavailable.evidence.state, "unavailable");
  assert.equal(unavailable.evidence.totalSku, null);
  await assert.rejects(answerPreviousRestock("tenant", { type: "unknown", items: [item(1)] }), /danh sách mã hàng/);
});

test("finds exactly one explicit displayed ordinal and refuses ambiguity", () => {
  for (const [question, position] of [["Mã đầu tiên còn bao nhiêu ngày bán?", 1], ["Mã thứ 2 còn bao nhiêu ngày?", 2],
    ["Mã thứ hai còn bao nhiêu ngày?", 2], ["Hàng thứ mười còn bao nhiêu ngày?", 10]]) {
    assert.equal(positionInQuestion(question, position), true);
  }
  for (const [question, position] of [["Mã đầu tiên còn bao nhiêu ngày?", 2], ["Mã thứ 12 còn bao nhiêu?", 1],
    ["Mã đó còn bao nhiêu?", 1], ["Mã đầu tiên và mã thứ hai?", 1], ["Mã thứ hai mươi?", 2]]) {
    assert.equal(positionInQuestion(question, position), false);
  }
});

test("uses the requested displayed SKU and fresh stock coverage without choosing other signals", async () => {
  setup();
  const prior = previous("top_sellers_overstock_v1");
  prior.state = "partial"; prior.totalSku = 3;
  outlook.items = [{ variantId: id(2), signals: [
    { type: "LOW_STOCK", current: false, metrics: { stockAvailable: 100, daysOfCover: 99 } },
    { type: "OVERSTOCK", current: true, metrics: { stockAvailable: 10, daysOfCover: 2.5, possibleStockoutBias: true } },
  ] }];
  const { evidence, text } = await answerPreviousItemCover("tenant", prior, 2);
  assert.deepEqual(calls, [["tenant", {}, { variantIds: [id(2)], all: true }]]);
  assert.equal(evidence.item.variantId, id(2));
  assert.equal(evidence.daysOfCover, 2.5);
  assert.equal(evidence.stockAvailable, 10);
  assert.equal(evidence.state, "partial");
  assert.equal(evidence.sourceTruncated, true);
  assert.equal(evidence.sourceInventoryCaution, true);
  assert.equal(evidence.possibleStockoutBias, true);
  assert.match(text, /có thể từng hết hàng/);
  await assert.rejects(answerPreviousItemCover("tenant", prior, 3), /chỉ có 2 mã/);
});

test("does not infer coverage from missing, stale, zero-demand or conflicting signals", async () => {
  setup();
  const prior = previous("top_sellers_v1", [item(1)]);
  const result = () => answerPreviousItemCover("tenant", prior, 1);
  const signal = (days, stock = 0) => ({ type: "LOW_STOCK", current: true, metrics: { stockAvailable: stock, daysOfCover: days, possibleStockoutBias: false } });
  outlook.items = [{ variantId: id(1), signals: [signal(0)] }];
  assert.equal((await result()).evidence.daysOfCover, 0);
  assert.equal((await result()).evidence.state, "ready");
  outlook.items[0].signals = [signal(null)];
  assert.equal((await result()).evidence.state, "unavailable");
  outlook.items[0].signals = [signal(2), { ...signal(3), type: "OVERSTOCK" }];
  assert.equal((await result()).evidence.state, "unavailable");
  outlook.items[0].signals = [];
  assert.equal((await result()).evidence.daysOfCover, null);
  outlook.ruleFresh = false;
  assert.equal((await result()).evidence.state, "unavailable");
  await assert.rejects(answerPreviousItemCover("tenant", prior, 0), /Vị trí/);
});

test("accepts a sales comparison as displayed context and preserves its data cautions", async () => {
  setup();
  const prior = { type: "sku_sales_comparison_v1", warnings, sourceWarnings: { ...warnings, excludedSaleItems: 1 },
    items: [{ ...item(1), current: null, previous: null, difference: null }] };
  assert.equal(hasPreviousSkuList(prior), true);
  outlook.items = [{ variantId: id(1), signals: [{ type: "OVERSTOCK", current: true,
    metrics: { stockAvailable: 20, daysOfCover: 9, possibleStockoutBias: false } }] }];
  assert.equal((await answerPreviousItemCover("tenant", prior, 1)).evidence.state, "partial");
});
