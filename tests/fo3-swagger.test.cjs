const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
require("ts-node/register/transpile-only");

// HTTP/documentation checks must not depend on a running PostgreSQL instance.
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma: {} } };
const app = require("../src/app.ts").default;
const { createFo3Document } = require("../src/docs/fo3.openapi.ts");

test("fo3 documents exactly the implemented purchases routes and resolves schema references", () => {
  const spec = createFo3Document();
  const source = fs.readFileSync(require.resolve("../src/modules/purchases/purchases.routes.ts"), "utf8");
  const implemented = [...source.matchAll(/router\.(get|post|patch)\("([^"]+)"/g)]
    .map(([, method, path]) => `${method} /purchases${path.replace(/:id/g, "{id}")}`).sort();
  const documented = Object.entries(spec.paths).filter(([path]) => path.startsWith("/purchases/"))
    .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method} ${path}`)).sort();
  assert.equal(documented.length, 20);
  assert.deepEqual(documented, implemented);
  for (const [, name] of JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)) {
    assert.ok(spec.components.schemas[name], `Missing schema ${name}`);
  }
  assert.equal(spec.info.title, "fo3");
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  assert.ok(!Object.keys(spec.paths).some((path) => /^\/(products|businesses|categories)/.test(path)));
});

test("fo3 serves local Swagger assets, login spec and automatic Bearer authorization", async () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL = "https://fo3-test.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-public-anon-key";
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/fo3/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>fo3<\/title>/);
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /connect-src 'self' https:\/\/fo3-test\.supabase\.co/);
    assert.ok(!csp.includes("upgrade-insecure-requests"));
    const specResponse = await fetch(`${base}/fo3/openapi.json`);
    assert.equal(specResponse.headers.get("cache-control"), "no-store");
    const spec = await specResponse.json();
    const login = spec.paths["/auth/v1/token"].post;
    assert.deepEqual(login.security, []);
    assert.equal(login.servers[0].url, process.env.SUPABASE_URL);
    assert.equal(login.parameters.find((p) => p.name === "apikey").schema.default, "test-public-anon-key");
    for (const asset of ["swagger-ui.css", "swagger-ui-bundle.js", "swagger-ui-standalone-preset.js"]) {
      const response = await fetch(`${base}/fo3/${asset}`);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    const initResponse = await fetch(`${base}/fo3/swagger-ui-init.js`);
    assert.equal(initResponse.status, 200);
    let options;
    const authorized = [];
    const bundle = (config) => { options = config; return { preauthorizeApiKey: (...args) => authorized.push(args) }; };
    bundle.presets = { apis: {} };
    bundle.plugins = { DownloadUrl: {} };
    const window = { location: { search: "", origin: base } };
    vm.runInNewContext(await initResponse.text(), { window, URL, SwaggerUIBundle: bundle, SwaggerUIStandalonePreset: {} });
    window.onload();
    assert.equal(options.url, "/fo3/openapi.json");
    assert.equal(options.persistAuthorization, false);
    options.responseInterceptor({ url: `${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, status: 200, obj: { access_token: "test-access-token" } });
    assert.deepEqual(authorized, [["bearerAuth", "test-access-token"]]);
    options.responseInterceptor({ url: `${process.env.SUPABASE_URL}/auth/v1/token`, status: 400, obj: { error: "Invalid credentials" } });
    assert.equal(authorized.length, 1);
    const protectedResponse = await fetch(`${base}/api/purchases/orders`);
    assert.equal(protectedResponse.status, 401);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    const unconfigured = createFo3Document();
    assert.equal(unconfigured.paths["/auth/v1/token"], undefined);
    assert.ok(unconfigured.info.description.includes("Chưa cấu hình"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = originalKey;
  }
});
