const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
require("ts-node/register/transpile-only");

function mock(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
const calls = [];
mock("../src/shared/auth/supabase-auth.middleware", { requireSupabaseIdentity: (_req, _res, next) => next() });
mock("../src/shared/auth/business-scope.middleware", { requireBusinessScope: (req, res, next) => {
  res.locals.businessId = "scoped-business";
  res.locals.permissionCodes = String(req.headers["x-test-permissions"] || "").split(",");
  next();
} });
mock("../src/modules/ai-insights/ai-insights.service", { aiInsightsService: {} });
mock("../src/modules/ai-forecast/replenishment.service", { replenishmentService: {} });
mock("../src/modules/ai-forecast/forecast-history.service", { forecastHistory: () => {} });
mock("../src/modules/ai-insights/inventory-outlook.service", { inventoryOutlook: async (businessId, query) => {
  calls.push({ businessId, query });
  return { state: "READY" };
} });
const router = require("../src/modules/ai-insights/ai-insights.routes").default;

test("inventory outlook requires analytics.read and uses the scoped business", async () => {
  const app = express();
  app.use(router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/inventory-outlook?businessId=other&search=SKU`;
    const denied = await fetch(url);
    assert.equal(denied.status, 403);
    assert.equal(calls.length, 0);
    const allowed = await fetch(url, { headers: { "x-test-permissions": "analytics.read" } });
    assert.equal(allowed.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].businessId, "scoped-business");
    assert.equal(calls[0].query.search, "SKU");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
