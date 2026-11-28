require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = { $transaction: undefined };
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma } };
const { buildInventoryOutlook, inventoryOutlook } = require("../src/modules/ai-insights/inventory-outlook.service");
const { answerSlowExpiry } = require("../src/modules/assistant/slow-expiry.service");

const asOf = new Date("2026-01-28T00:00:00Z");
const finishedAt = new Date("2026-01-29T04:00:00Z");
const latest = { id: "new", dataAsOf: asOf, finishedAt };
const variant = (sku) => ({ sku, template: { name: `Sản phẩm ${sku}`, category: { name: "Danh mục" } } });
const signal = (id, variantId, type, level, overrides = {}) => ({
  id, variantId, runId: "new", type, severity: level, status: "OPEN", reasonCode: "R",
  suggestedAction: "INVESTIGATE", metrics: { stockAvailable: 4, costPrice: 55, basePrice: 99, nested: { amount: 10 } },
  lastDetectedAt: finishedAt, variant: variant(variantId), lotItem: null, run: { dataAsOf: asOf, finishedAt }, ...overrides,
});
const suggestion = (variantId, overrides = {}) => ({
  id: `suggest-${variantId}`, variantId, runId: "new", status: "PENDING", urgency: "HIGH", confidence: "HIGH",
  suggestedQty: 5, orderByDate: asOf, stockoutDate: null, details: { onOrder: 3, costPrice: 10, amount: 100, incoming: [{ unitCost: 5 }] },
  updatedAt: finishedAt, variant: variant(variantId), supplier: { name: "Nhà cung cấp" }, po: null, ...overrides,
});

test("groups unique SKUs, preserves conflicting signals and lots, and never exposes financial JSON", () => {
  const rows = [
    signal("low", "A", "LOW_STOCK", "MEDIUM"),
    signal("exp1", "A", "EXPIRATION_RISK", "HIGH", { status: "ACKNOWLEDGED", lotItem: { expirationDate: asOf, lot: { lotNumber: "L1" } } }),
    signal("exp2", "A", "EXPIRATION_RISK", "CRITICAL", { lotItem: { expirationDate: asOf, lot: { lotNumber: "L2" } } }),
    signal("slow", "B", "SLOW_MOVING", "LOW"),
  ];
  const items = buildInventoryOutlook(rows, [suggestion("A"), suggestion("C", {
    status: "ORDERED", runId: "old", po: { status: "DRAFT", poCode: "PO-1" },
  })], [latest, { id: "old", dataAsOf: asOf, finishedAt }], latest, true, true);
  assert.deepEqual(items.map((item) => item.variantId), ["A", "B", "C"]);
  assert.equal(items[0].priority, "CRITICAL");
  assert.deepEqual(items[0].signals.map((item) => item.lotNumber), [null, "L1", "L2"]);
  assert.equal(items[0].signals[1].status, "ACKNOWLEDGED");
  assert.equal(items[2].priority, null);
  assert.equal(items[2].replenishment.current, false);
  const json = JSON.stringify(items);
  for (const forbidden of ["costPrice", "basePrice", "unitCost", "amount", "incoming"]) assert.equal(json.includes(forbidden), false);
  assert.equal(items[0].signals[0].metrics.stockAvailable, 4);
});

test("forecast outage and stale runs do not turn old risks into current priorities", () => {
  const rows = [
    signal("old", "A", "STOCKOUT_RISK", "CRITICAL", { runId: "old" }),
    signal("exp", "A", "EXPIRATION_RISK", "HIGH", { metrics: { rateSource: "FORECAST" } }),
    signal("fresh", "A", "LOW_STOCK", "MEDIUM"),
  ];
  const [item] = buildInventoryOutlook(rows, [suggestion("A")], [latest], latest, true, false);
  assert.deepEqual(item.signals.map((entry) => entry.current), [false, false, true]);
  assert.equal(item.priority, "MEDIUM");
  assert.equal(item.replenishment.current, false);
  assert.equal(buildInventoryOutlook(rows, [], [], latest, false, true)[0].priority, null);
});

test("API uses one tenant-scoped snapshot, filters and counts before pagination", async (t) => {
  const original = prisma.$transaction;
  const queries = [];
  prisma.$transaction = async (fn, options) => {
    assert.equal(options.isolationLevel, "RepeatableRead");
    return fn({
      $queryRaw: async () => [{ today: "2026-01-29", now: new Date("2026-01-29T05:00:00Z") }],
      aiInsightRun: {
        findFirst: async (q) => { queries.push(q); return { ...latest, status: "SUCCEEDED", startedAt: finishedAt, summary: { publicationVersion: 1, forecastStatus: "READY", hasSyntheticSku: true }, warnings: [] }; },
        findMany: async (q) => { queries.push(q); return [latest]; },
      },
      aiInsight: { findMany: async (q) => { queries.push(q); return [
        signal("1", "A", "LOW_STOCK", "HIGH"), signal("2", "A", "EXPIRATION_RISK", "CRITICAL"),
        signal("3", "B", "LOW_STOCK", "HIGH"), signal("4", "C", "LOW_STOCK", "LOW"),
      ]; } },
      aiReplenishmentItem: { findMany: async (q) => { queries.push(q); return [suggestion("A")]; } },
    });
  };
  t.after(() => { prisma.$transaction = original; });
  const result = await inventoryOutlook("tenant", { type: "LOW_STOCK", page: "2", pageSize: "1" });
  assert.equal(result.summary.totalSku, 3);
  assert.equal(result.hasSyntheticSku, true);
  assert.equal(result.total, 3);
  assert.deepEqual(result.items.map((item) => item.sku), ["B"]);
  assert.equal(result.summary.byPriority.CRITICAL, 1);
  for (const query of queries) assert.equal(query.where.businessId, "tenant");
  assert.deepEqual(queries[1].where.status.in, ["OPEN", "ACKNOWLEDGED"]);
  assert.equal(queries[2].where.OR[1].po.is.status, "DRAFT");
  const beyond = await inventoryOutlook("tenant", { page: "99", pageSize: "2" });
  assert.equal(beyond.page, 2);
  assert.deepEqual(beyond.items.map((item) => item.sku), ["C"]);
  const scoped = await inventoryOutlook("tenant", { page: "1", pageSize: "1" }, { variantIds: ["C"] });
  assert.equal(scoped.total, 1);
  assert.deepEqual(scoped.items.map((item) => item.sku), ["C"]);
  const empty = await inventoryOutlook("tenant", {}, { variantIds: [] });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.items, []);
  const all = await inventoryOutlook("tenant", { pageSize: "1" }, { all: true });
  assert.equal(all.total, 3);
  assert.deepEqual(all.items.map((item) => item.sku), ["A", "B", "C"]);
});

test("missing, running, failed, and legacy runs never report an empty successful analysis", async (t) => {
  const original = prisma.$transaction;
  let latestRun = null;
  prisma.$transaction = async (fn) => fn({
    $queryRaw: async () => [{ today: "2026-01-29", now: finishedAt }],
    aiInsightRun: { findFirst: async () => latestRun },
  });

  t.after(() => { prisma.$transaction = original; });
  for (const [run, state] of [
    [null, "NOT_RUN"], [{ ...latest, status: "RUNNING" }, "RUNNING"],
    [{ ...latest, status: "FAILED" }, "FAILED"],
    [{ ...latest, status: "SUCCEEDED", summary: { forecastStatus: "READY" } }, "INCOMPLETE"],
  ]) {
    latestRun = run;
    const result = await inventoryOutlook("tenant", {});
    assert.equal(result.state, state);
    assert.equal(result.items, null);
    assert.equal(result.total, null);
  }
});

test("assistant combines alerts beyond the first inventory page within the same snapshot", async (t) => {
  const original = prisma.$transaction;
  const queries = [];
  prisma.$transaction = async (fn) => fn({
    $queryRaw: async () => [{ today: "2026-01-29", now: new Date("2026-01-29T05:00:00Z") }],
    aiInsightRun: {
      findFirst: async (q) => { queries.push(q); return {
        ...latest, status: "SUCCEEDED", startedAt: finishedAt,
        summary: { publicationVersion: 1, forecastStatus: "READY" }, warnings: [],
      }; },
    },
    aiInsight: { findMany: async (q) => { queries.push(q); return [
      ...Array.from({ length: 105 }, (_, index) => signal(`other-${index}`, `other-${index}`, "LOW_STOCK", "CRITICAL")),
      signal("slow", "target", "SLOW_MOVING", "LOW", { metrics: { sold30: 1, stockAvailable: 4 } }),
      signal("expiry", "target", "EXPIRATION_RISK", "LOW", {
        reasonCode: "DEMAND_BELOW_STOCK_BEFORE_EXPIRY",
        metrics: { atRiskQty: 3, lotQuantity: 4, rateSource: "AVG_30" },
        lotItem: { expirationDate: new Date("2026-02-20T00:00:00Z"), lot: { lotNumber: "lot-1" } },
      }),
    ]; } },
    aiReplenishmentItem: { findMany: async (q) => { queries.push(q); return []; } },
  });
  t.after(() => { prisma.$transaction = original; });
  const result = await answerSlowExpiry("tenant");
  assert.equal(result.evidence.totalSku, 1);
  assert.equal(result.evidence.items[0].sku, "target");
  assert.equal(result.evidence.items[0].lots[0].lotNumber, "lot-1");
  assert.deepEqual(queries[1].where.status.in, ["OPEN", "ACKNOWLEDGED"]);
  for (const query of queries) assert.equal(query.where.businessId, "tenant");
});

test("forecast comparison reads only current overstock SKUs and gross POS totals in the same tenant snapshot", async (t) => {
  const original = prisma.$transaction;
  const queries = [];
  prisma.$transaction = async (fn, options) => {
    assert.equal(options.isolationLevel, "RepeatableRead");
    return fn({
      $queryRaw: async () => [{ today: "2026-01-29", now: new Date("2026-01-29T05:00:00Z") }],
      aiInsightRun: { findFirst: async () => ({ ...latest, status: "SUCCEEDED", startedAt: finishedAt,
        summary: { publicationVersion: 1, forecastStatus: "READY" }, warnings: [] }) },
      aiInsight: { findMany: async () => [
        signal("over", "A", "OVERSTOCK", "LOW"), signal("old", "B", "OVERSTOCK", "HIGH", { runId: "old" }),
        signal("other", "C", "LOW_STOCK", "HIGH"),
      ] },
      aiReplenishmentItem: { findMany: async () => [] },
      aiForecast: { findMany: async (q) => { queries.push(q); return []; } },
      channelDailyProductMetric: { groupBy: async (q) => { queries.push(q); return []; } },
    });
  };
  t.after(() => { prisma.$transaction = original; });
  const result = await inventoryOutlook("tenant", {}, { all: true, includeForecastComparison: true });
  assert.equal(result.forecastContext.latest.id, "new");
  assert.deepEqual(queries[0].where, { businessId: "tenant", variantId: { in: ["A"] } });
  assert.equal(queries[1].where.businessId, "tenant");
  assert.equal(queries[1].where.channel, "POS");
  assert.deepEqual(queries[1].where.variantId.in, ["A"]);
  assert.equal(queries[1].where.metricDate.gte.toISOString(), "2025-12-30T00:00:00.000Z");
  assert.equal(queries[1].where.metricDate.lte.toISOString(), "2026-01-28T00:00:00.000Z");
  assert.deepEqual(queries[1]._sum, { unitsSold: true });
});
