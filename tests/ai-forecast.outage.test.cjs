require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../src/shared/infrastructure/database/prisma.client");
const snapshot = require("../src/modules/ai-insights/snapshot/build-snapshot");
const { aiInsightsService } = require("../src/modules/ai-insights/ai-insights.service");
const { replenishmentService } = require("../src/modules/ai-forecast/replenishment.service");

test("outage preserves existing forecast-dependent alerts while independent alerts can resolve", async (t) => {
  const updated = [];
  const original = prisma.$transaction;
  prisma.$transaction = async (fn) => fn({
    $queryRaw: async () => [],
    aiInsight: {
      findMany: async () => [
        { id: "stockout", fingerprint: "s", type: "STOCKOUT_RISK", status: "OPEN" },
        { id: "low", fingerprint: "l", type: "LOW_STOCK", status: "OPEN" },
      ],
      updateMany: async (params) => { updated.push(...params.where.id.in); },
    },
  });
  t.after(() => { prisma.$transaction = original; });
  const result = await aiInsightsService.persist("business", "run", [], "2025-01-29", async () => ({}), false);
  assert.deepEqual(updated, ["low"]);
  assert.equal(result.resolved, 1);
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
