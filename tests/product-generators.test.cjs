require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cartesian } = require('../src/modules/products/utils/cartesian');
let findVariant;
const databasePath = require.resolve('../src/shared/infrastructure/database/prisma.client');
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: {
  prisma: { productVariant: { findFirst: args => findVariant(args) } },
} };
const { SkuGeneratorService } = require('../src/modules/products/services/sku-generator.service');
const { BarcodeGeneratorService } = require('../src/modules/products/services/barcode-generator.service');

test('variant combinations preserve selection order without mutating the inputs', () => {
  const input = [['red', 'blue'], ['S', 'M']];
  assert.deepEqual(cartesian(input), [['red', 'S'], ['red', 'M'], ['blue', 'S'], ['blue', 'M']]);
  assert.deepEqual(input, [['red', 'blue'], ['S', 'M']]);
  assert.deepEqual(cartesian([]), []);
  assert.deepEqual(cartesian([['red'], []]), []);
});
test('SKU generator normalizes labels and resolves collisions within the business', async () => {
  const calls = [];
  findVariant = async args => { calls.push(args); return calls.length < 3 ? { id: 'existing' } : null; };
  const sku = await new SkuGeneratorService().generate({ businessId: 'shop', templateName: 'Áo thun', valueLabels: ['Xanh', 'XL'] });
  assert.equal(sku, 'AOTHUN-XANH-XL-002');
  assert.deepEqual(calls.map(call => call.where), ['AOTHUN-XANH-XL', 'AOTHUN-XANH-XL-001', 'AOTHUN-XANH-XL-002'].map(sku => ({ businessId: 'shop', sku })));
});
test('single SKU supports a fallback name and propagates database errors', async () => {
  findVariant = async () => null;
  assert.equal(await new SkuGeneratorService().generateSingle({ businessId: 'shop', templateName: '!!!' }), 'PRD');
  const failure = new Error('database unavailable');
  findVariant = async () => { throw failure; };
  await assert.rejects(new SkuGeneratorService().generateSingle({ businessId: 'shop', templateName: 'Shirt' }), error => error === failure);
});
test('EAN13 uses a valid checksum and retries collisions within the business', async t => {
  t.mock.method(Math, 'random', () => 0.1);
  let calls = 0;
  findVariant = async ({ where }) => {
    assert.equal(where.businessId, 'shop');
    assert.match(where.barcode, /^200\d{10}$/);
    const digits = [...where.barcode].map(Number);
    assert.equal(digits.reduce((sum, digit, index) => sum + digit * (index % 2 ? 3 : 1), 0) % 10, 0);
    return ++calls === 1 ? { id: 'existing' } : null;
  };
  await new BarcodeGeneratorService().generate({ businessId: 'shop', type: 'EAN13' });
  assert.equal(calls, 2);
});
test('CODE128 generation returns the supported internal format', async t => {
  t.mock.method(Math, 'random', () => 0.5);
  findVariant = async () => null;
  assert.match(await new BarcodeGeneratorService().generate({ businessId: 'shop', type: 'CODE128' }), /^C128\d{12}$/);
});
test('barcode generation stops after 50 collisions', async () => {
  let calls = 0;
  findVariant = async () => { calls++; return { id: 'existing' }; };
  await assert.rejects(new BarcodeGeneratorService().generate({ businessId: 'shop', type: 'EAN13' }));
  assert.equal(calls, 50);
});
