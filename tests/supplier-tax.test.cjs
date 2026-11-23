const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
const { normalizeTaxCode, lookupSupplierTax } = require("../src/modules/purchases/supplier-tax.service.ts");
test("tax code validates before network access and normalizes branches", () => {
  assert.equal(normalizeTaxCode(" 0316794479001 "), "0316794479-001");
  assert.equal(normalizeTaxCode("012345678901"), "012345678901");
  for (const value of ["", "../", "123", [], undefined, "0316794479?x=1"]) assert.throws(() => normalizeTaxCode(value), e => e.statusCode === 400);
});
test("lookup uses server credentials, caches token, and handles absent results and rate limits", async () => {
  const originalFetch = global.fetch; const appId = process.env.CASSO_APP_ID; const secret = process.env.CASSO_APP_SECRET;
  process.env.CASSO_APP_ID = "app-test"; process.env.CASSO_APP_SECRET = "secret-test";
  let tokenCalls = 0; let status = 200; let wrongCode = false;
  global.fetch = async (url, init) => {
    assert.ok(init.signal);
    if (url.endsWith("/oauth/token")) {
      tokenCalls++; assert.deepEqual(JSON.parse(init.body), { app_id: "app-test", app_secret: "secret-test" });
      return new Response(JSON.stringify({ access_token: "token", expires_in: 900 }));
    }
    assert.equal(init.headers.Authorization, "Bearer token");
    return new Response(JSON.stringify({ business: { taxCode: wrongCode ? "9999999999" : "0316794479", name: "Company", address: "Address" } }), { status });
  };
  try {
    assert.equal((await lookupSupplierTax("0316794479")).name, "Company");
    await lookupSupplierTax("0316794479"); assert.equal(tokenCalls, 1);
    status = 404; await assert.rejects(lookupSupplierTax("0316794479"), e => e.statusCode === 404);
    status = 429; await assert.rejects(lookupSupplierTax("0316794479"), e => e.statusCode === 429);
    status = 200; wrongCode = true; await assert.rejects(lookupSupplierTax("0316794479"), e => e.statusCode === 502);
  } finally {
    global.fetch = originalFetch;
    if (appId === undefined) delete process.env.CASSO_APP_ID; else process.env.CASSO_APP_ID = appId;
    if (secret === undefined) delete process.env.CASSO_APP_SECRET; else process.env.CASSO_APP_SECRET = secret;
  }
});
