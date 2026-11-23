const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

let metricQuery;
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { prisma: {
    channelDailyProductMetric: { findMany: async (query) => { metricQuery = query; return []; } },
  } },
};
const { BusinessDataService } = require("../src/modules/business-data/business-data.service.ts");

test("core AI-ready data is POS-only and tenant scoped", async () => {
  const result = await new BusinessDataService().getAiReadyData("business-1", "2026-04-20", "2026-04-23");
  assert.equal(metricQuery.where.businessId, "business-1");
  assert.equal(metricQuery.where.channel, "POS");
  assert.deepEqual(Object.keys(result).sort(), ["pos", "range"]);
  assert.equal(result.pos.hasMetrics, false);
});
