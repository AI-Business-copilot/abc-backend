const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");

const router = require("../src/routes").default;

test("online report endpoints are unavailable while the API remains mounted", async () => {
  const app = express();
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    for (const [method, path] of [
      ["POST", "/online-reports/shopee/preview"],
      ["POST", "/online-reports/shopee/import"],
      ["GET", "/online-reports/shopee/imports"],
      ["GET", "/online-reports/shopee/records?from=2026-01-01&to=2026-01-02"],
    ]) {
      assert.equal((await fetch(`${base}${path}`, { method })).status, 404);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
