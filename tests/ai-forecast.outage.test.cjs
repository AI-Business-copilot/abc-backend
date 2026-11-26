require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
// Mock the database boundary so unit tests do not depend on generated delegates or credentials.
const prisma = { aiInsightRun: {}, aiForecast: {}, aiReplenishmentItem: {}, $transaction: undefined };
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma } };
const snapshot = require("../src/modules/ai-insights/snapshot/build-snapshot");
const { aiInsightsService } = require("../src/modules/ai-insights/ai-insights.service");
const { replenishmentService } = require("../src/modules/ai-forecast/replenishment.service");
const { businessDataService } = require("../src/modules/business-data/business-data.service");

test("outage preserves existing forecast-dependent alerts while independent alerts can resolve", async (t) => {
  const updated = [];
  const original = prisma.$transaction;
  prisma.$transaction = async (fn) => fn({
    $queryRaw: async () => [],
    aiInsightRun: {
      findFirst: async () => ({ id: "run", status: "RUNNING" }),
      update: async () => ({}),
    },
    aiInsight: {
      findMany: async () => [
        { id: "stockout", fingerprint: "s", type: "STOCKOUT_RISK", status: "OPEN" },
        { id: "low", fingerprint: "l", type: "LOW_STOCK", status: "OPEN" },
      ],
      updateMany: async (params) => { updated.push(...params.where.id.in); },
    },
  });
  t.after(() => { prisma.$transaction = original; });
  const analysis = { findings: [], warnings: [], variantsAnalyzed: 0, capital: {}, hasSyntheticSku: false };
  const result = await aiInsightsService.persist("business", "run", analysis, {}, "2025-01-29", async () => ({}), false);
  assert.deepEqual(updated, ["low"]);
  assert.equal(result.resolved, 1);
});

test("a superseded analysis cannot publish over a newer run", async (t) => {
  const original = prisma.$transaction;
  let modified = false;
  prisma.$transaction = async (fn) => fn({
    $queryRaw: async () => [],
    aiInsightRun: { findFirst: async () => ({ id: "newer", status: "RUNNING" }) },
    aiInsight: { findMany: async () => { modified = true; return []; } },
  });
  t.after(() => { prisma.$transaction = original; });
  const analysis = { findings: [], warnings: [], variantsAnalyzed: 0, capital: {}, hasSyntheticSku: false };
  await assert.rejects(aiInsightsService.persist("business", "old", analysis, {}, "2025-01-29", async () => ({}), false), /superseded/);
  assert.equal(modified, false);
});

test("a publication error cannot commit findings or mark the run successful", async (t) => {
  const original = prisma.$transaction;
  const committed = [];
  let successUpdated = false;
  prisma.$transaction = async (fn) => {
    const staged = [];
    const value = await fn({
      $queryRaw: async () => [],
      aiInsightRun: {
        findFirst: async () => ({ id: "run", status: "RUNNING" }),
        update: async () => { successUpdated = true; },
      },
      aiInsight: {
        findMany: async () => [{ id: "low", fingerprint: "l", type: "LOW_STOCK", status: "OPEN" }],
        updateMany: async () => staged.push("resolved"),
      },
    });
    committed.push(...staged);
    return value;
  };
  t.after(() => { prisma.$transaction = original; });
  const analysis = { findings: [], warnings: [], variantsAnalyzed: 0, capital: {}, hasSyntheticSku: false };
  await assert.rejects(aiInsightsService.persist("business", "run", analysis, {}, "2025-01-29", async () => {
    throw new Error("forecast write failed");
  }, true), /forecast write failed/);
  assert.deepEqual(committed, []);
  assert.equal(successUpdated, false);
});

test("failure to mark success rolls back staged findings and forecasts", async (t) => {
  const original = prisma.$transaction;
  const committed = [];
  let staged;
  prisma.$transaction = async (fn) => {
    staged = [];
    const value = await fn({
      $queryRaw: async () => [],
      aiInsightRun: {
        findFirst: async () => ({ id: "run", status: "RUNNING" }),
        update: async () => { throw new Error("status write failed"); },
      },
      aiInsight: {
        findMany: async () => [{ id: "low", fingerprint: "l", type: "LOW_STOCK", status: "OPEN" }],
        updateMany: async () => staged.push("resolved"),
      },
    });
    committed.push(...staged);
    return value;
  };
  t.after(() => { prisma.$transaction = original; });
  const analysis = { findings: [], warnings: [], variantsAnalyzed: 0, capital: {}, hasSyntheticSku: false };
  await assert.rejects(aiInsightsService.persist("business", "run", analysis, {}, "2025-01-29", async () => {
    staged.push("forecasts");
    return {};
  }, true), /status write failed/);
  assert.deepEqual(staged, ["resolved", "forecasts"]);
  assert.deepEqual(committed, []);
});

test("concurrent starts create only one running analysis", async (t) => {
  const original = { transaction: prisma.$transaction, query: prisma.$queryRaw, updateMany: prisma.aiInsightRun.updateMany };
  let latest = null;
  let chain = Promise.resolve();
  let release;
  let rebuildStarted;
  const started = new Promise((resolve) => { rebuildStarted = resolve; });
  const blocked = new Promise((_resolve, reject) => { release = reject; });
  const tx = {
    $queryRaw: async (parts) => parts.join("").includes("clock_timestamp") ? [{ now: new Date() }] : [],
    aiInsightRun: {
      findFirst: async () => latest,
      create: async ({ data }) => { latest = { id: "run", ...data }; return latest; },
    },
  };
  prisma.$queryRaw = async () => [{ today: "2025-01-29" }];
  prisma.$transaction = (fn) => {
    const work = chain.then(() => fn(tx));
    chain = work.catch(() => {});
    return work;
  };
  prisma.aiInsightRun.updateMany = async () => { latest.status = "FAILED"; };
  t.mock.method(aiInsightsService, "getSettings", async () => ({}));
  t.mock.method(businessDataService, "rebuildPosMetrics", async () => { rebuildStarted(); return blocked; });
  t.after(() => {
    prisma.$transaction = original.transaction;
    prisma.$queryRaw = original.query;
    prisma.aiInsightRun.updateMany = original.updateMany;
  });
  const first = aiInsightsService.run("business", "SCHEDULED", null);
  await started;
  await assert.rejects(aiInsightsService.run("business", "SCHEDULED", null), /already running/);
  release(new Error("controlled failure"));
  await assert.rejects(first, /controlled failure/);
  assert.equal(latest.status, "FAILED");
});

test("unavailable forecasts remain visible as stale and cannot create draft orders", async (t) => {
  t.mock.method(snapshot, "businessToday", async () => "2025-01-29");
  const runs = prisma.aiInsightRun;
  const forecasts = prisma.aiForecast;
  const suggestions = prisma.aiReplenishmentItem;
  const previous = [runs.findFirst, forecasts.findFirst, suggestions.findMany];
  runs.findFirst = async () => ({
    id: "run", status: "SUCCEEDED", dataAsOf: new Date("2025-01-28T00:00:00Z"),
    summary: { forecastStatus: "UNAVAILABLE" },
  });
  forecasts.findFirst = async () => ({ asOf: new Date("2025-01-27T00:00:00Z") });
  suggestions.findMany = async () => [];
  t.after(() => { [runs.findFirst, forecasts.findFirst, suggestions.findMany] = previous; });
  const result = await replenishmentService.list("business", {});
  assert.equal(result.forecastReady, false);
  assert.equal(result.forecastAsOf, "2025-01-27");
  await assert.rejects(
    replenishmentService.createDraftOrders("business", "auth", "user", { items: [{ id: "item" }] }),
    /không khả dụng/,
  );
});
