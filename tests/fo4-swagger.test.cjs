const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
require('ts-node/register/transpile-only');
const dbPath = require.resolve('../src/shared/infrastructure/database/prisma.client.ts');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: {} } };
const app = require('../src/app.ts').default;
const { createFo4Document } = require('../src/docs/fo4.openapi.ts');

test('F04 documents every sales route and contains only F04 preparation and sales paths', () => {
  const spec = createFo4Document();
  const source = fs.readFileSync(require.resolve('../src/modules/sales/sales.routes.ts'), 'utf8');
  const actual = [...source.matchAll(/router\.(get|post)\("([^"]+)"/g)].map(([, method, path]) => `${method} /sales${path.replace(/:id/g, '{id}')}`).sort();
  const documented = Object.entries(spec.paths).filter(([path]) => path.startsWith('/sales/')).flatMap(([path, ops]) => Object.keys(ops).map(method => `${method} ${path}`)).sort();
  assert.equal(actual.length, 10); assert.deepEqual(documented, actual);
  assert.ok(Object.keys(spec.paths).every(path => /^\/(sales\/|auth\/|inventory\/|health$)/.test(path)));
  for (const [, name] of JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)) assert.ok(spec.components.schemas[name], name);
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  assert.equal(spec.info.title, 'fo4');
  // Sales returns the ProductLotItem relation, with its parent lot nested inside.
  const item = spec.components.schemas.OrderItem.properties;
  assert.ok(item.lotItemId);
  assert.equal(item.lotItem.nullable, true);
  assert.ok(item.lotItem.properties.expirationDate);
  assert.ok(item.lotItem.properties.lot.properties.lotNumber);
  assert.equal(item.lot, undefined);
});

test('F03 and F04 Swagger assets/config stay isolated and F04 login auto-authorizes', async () => {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL = 'https://fo4-test.supabase.co'; process.env.SUPABASE_ANON_KEY = 'public-test-key';
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Alternate pages to catch swagger-ui-express's shared initializer state.
    for (const name of ['fo3', 'fo4', 'fo3', 'fo4']) {
      const page = await fetch(`${base}/${name}/`);
      assert.equal(page.status, 200); assert.match(await page.text(), new RegExp(`<title>${name}</title>`));
      assert.match(page.headers.get('content-security-policy'), /connect-src 'self' https:\/\/fo4-test\.supabase\.co/);
      const init = await fetch(`${base}/${name}/swagger-ui-init.js`);
      let options; const authorized = [];
      const bundle = config => { options = config; return { preauthorizeApiKey: (...args) => authorized.push(args) }; };
      bundle.presets = { apis: {} }; bundle.plugins = { DownloadUrl: {} };
      const window = { location: { search: '', origin: base } };
      vm.runInNewContext(await init.text(), { window, URL, SwaggerUIBundle: bundle, SwaggerUIStandalonePreset: {} }); window.onload();
      assert.equal(options.url, `/${name}/openapi.json`); assert.equal(options.persistAuthorization, false);
      options.responseInterceptor({ url: `${process.env.SUPABASE_URL}/auth/v1/token`, status: 200, obj: { access_token: 'test-token' } });
      assert.deepEqual(authorized, [['bearerAuth', 'test-token']]);
    }
    for (const asset of ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js']) {
      const result = await fetch(`${base}/fo4/${asset}`); assert.equal(result.status, 200); await result.arrayBuffer();
    }
    const result = await fetch(`${base}/fo4/openapi.json`); assert.equal(result.headers.get('cache-control'), 'no-store');
    const spec = await result.json();
    assert.equal(spec.paths['/auth/v1/token'].post.parameters.find(p => p.name === 'apikey').schema.default, 'public-test-key');
    for (const path of ['/api/sales/orders', '/api/sales/orders/promotion-preview', '/api/sales/customers', '/api/sales/cash-shifts/current']) assert.equal((await fetch(`${base}${path}`)).status, 401);
    const payment = await fetch(`${base}/api/sales/orders/11111111-1111-4111-8111-111111111111/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(payment.status, 401);
    delete process.env.SUPABASE_URL; delete process.env.SUPABASE_ANON_KEY;
    assert.equal(createFo4Document().paths['/auth/v1/token'], undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = url;
    if (key === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = key;
  }
});
