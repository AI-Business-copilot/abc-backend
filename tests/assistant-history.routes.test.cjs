const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
require("ts-node/register/transpile-only");

function mock(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const id = "77777777-7777-4777-8777-777777777777";
let calls = [];
let stored;
mock("../src/shared/auth/supabase-auth.middleware", { requireSupabaseIdentity: (_req, _res, next) => next() });
mock("../src/shared/auth/business-scope.middleware", { requireBusinessScope: (req, res, next) => {
  res.locals.businessId = String(req.headers["x-business"] || "business-a");
  res.locals.userId = String(req.headers["x-user"] || "user-a");
  res.locals.permissionCodes = String(req.headers["x-permissions"] || "").split(",");
  next();
} });
mock("../src/shared/infrastructure/database/prisma.client", { prisma: { assistantConversation: {
  create: async (args) => { calls.push(["create", args]); return { id }; },
  findMany: async (args) => { calls.push(["list", args]); return []; },
  findFirst: async (args) => {
    calls.push(["find", args]);
    return stored && args.where.businessId === "business-a" && args.where.userId === "user-a" && args.where.id === id ? stored : null;
  },
  deleteMany: async (args) => {
    calls.push(["delete", args]);
    return { count: args.where.businessId === "business-a" && args.where.userId === "user-a" && args.where.id === id ? 1 : 0 };
  },
} } });
const router = require("../src/modules/assistant/assistant.routes").default;

async function withServer(run) {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("history is scoped to the current user and business", async () => {
  calls = [];
  stored = { id, messages: [] };
  await withServer(async (root) => {
    assert.equal((await fetch(`${root}/conversations`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${root}/conversations`, { method: "POST", headers: { "x-permissions": "analytics.read" } })).status, 201);
    assert.deepEqual(calls[0][1].data, { businessId: "business-a", userId: "user-a" });
    await fetch(`${root}/conversations?page=2`, { headers: { "x-business": "business-b", "x-user": "user-b" } });
    assert.deepEqual(calls[1][1].where, { businessId: "business-b", userId: "user-b" });
    assert.equal(calls[1][1].skip, 50);
    assert.equal((await fetch(`${root}/conversations/${id}`, { headers: { "x-permissions": "analytics.read", "x-user": "user-b" } })).status, 404);
    assert.equal((await fetch(`${root}/conversations/${id}`, { method: "DELETE", headers: { "x-business": "business-b" } })).status, 404);
    assert.equal((await fetch(`${root}/conversations/${id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${root}/conversations/not-a-uuid`, { method: "DELETE" })).status, 400);
  });
});

test("revoked financial permission prevents reading the entire conversation", async () => {
  calls = [];
  stored = { id, messages: [{ id, role: "assistant", content: "financial data", requiredPermissions: ["analytics.read", "finance.read"] }] };
  await withServer(async (root) => {
    const url = `${root}/conversations/${id}`;
    const denied = await fetch(url, { headers: { "x-permissions": "analytics.read" } });
    assert.equal(denied.status, 403);
    assert.doesNotMatch(await denied.text(), /financial data/);
    assert.equal((await fetch(url, { headers: { "x-permissions": "analytics.read,finance.read" } })).status, 200);
  });
});
