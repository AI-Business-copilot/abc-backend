const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
require("ts-node/register/transpile-only");

function mock(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
let calls = [];
let movementCalls = [];
let simulationCalls = [];
mock("../src/shared/auth/supabase-auth.middleware", { requireSupabaseIdentity: (_req, _res, next) => next() });
mock("../src/shared/auth/business-scope.middleware", { requireBusinessScope: (req, res, next) => {
  res.locals.businessId = "scoped-business";
  res.locals.permissionCodes = String(req.headers["x-test-permissions"] || "").split(",");
  next();
} });
mock("../src/modules/business-data/business-data.service", { businessDataService: {} });
mock("../src/modules/business-data/product-performance.service", { getProductPerformance: async (businessId, query) => {
  calls.push({ businessId, query });
  return { items: [] };
} });
mock("../src/modules/business-data/business-movement.service", { getBusinessMovement: async (businessId, query) => {
  movementCalls.push({ businessId, query });
  return { items: [] };
} });
mock("../src/modules/business-data/profit-simulation.service", {
  searchSimulationCategories: async (businessId, query) => { simulationCalls.push({ businessId, query }); return { items: [] }; },
  searchSimulationVariants: async (businessId, query) => { simulationCalls.push({ businessId, query }); return { items: [] }; },
  getSimulationBasis: async (businessId, query) => { simulationCalls.push({ businessId, query }); return {}; },
  simulateProfit: async (businessId, body) => { simulationCalls.push({ businessId, body }); return {}; },
});
const router = require("../src/modules/business-data/business-data.routes").default;

test("performance route requires both permissions and uses the scoped business", async () => {
  const app = express();
  app.use(router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/product-performance?from=2026-04-20&to=2026-04-23`;
    for (const permissions of ["", "analytics.read", "finance.read"]) {
      const response = await fetch(url, { headers: { "x-test-permissions": permissions } });
      assert.equal(response.status, 403);
    }
    assert.equal(calls.length, 0);
    const response = await fetch(url, { headers: { "x-test-permissions": "analytics.read,finance.read" } });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].businessId, "scoped-business");
    assert.equal(calls[0].query.from, "2026-04-20");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("movement route requires both permissions and uses the scoped business", async () => {
  const app = express();
  app.use(router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/business-movement?from=2026-04-20&to=2026-04-23&businessId=other`;
    for (const permissions of ["", "analytics.read", "finance.read"]) {
      assert.equal((await fetch(url, { headers: { "x-test-permissions": permissions } })).status, 403);
    }
    assert.equal(movementCalls.length, 0);
    assert.equal((await fetch(url, { headers: { "x-test-permissions": "analytics.read,finance.read" } })).status, 200);
    assert.equal(movementCalls.length, 1);
    assert.equal(movementCalls[0].businessId, "scoped-business");
    assert.equal(movementCalls[0].query.from, "2026-04-20");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("simulation endpoints require both permissions and ignore client business scope", async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const root = `http://127.0.0.1:${server.address().port}/profit-simulation`;
    for (const [path, method] of [["categories?businessId=other", "GET"], ["variants?businessId=other", "GET"], ["basis?businessId=other", "GET"], ["calculate", "POST"]]) {
      for (const permissions of ["", "analytics.read", "finance.read"]) {
        assert.equal((await fetch(`${root}/${path}`, { method, headers: { "x-test-permissions": permissions } })).status, 403);
      }
      const response = await fetch(`${root}/${path}`, { method, headers: { "x-test-permissions": "analytics.read,finance.read", "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ businessId: "other" }) } : {}) });
      assert.equal(response.status, 200);
      assert.equal(simulationCalls[simulationCalls.length - 1].businessId, "scoped-business");
    }
    assert.equal(simulationCalls.length, 4);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
