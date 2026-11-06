const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma: {} } };
const { validateSupplierOrder } = require("../src/modules/purchases/supplier-order.ts");
const { supplierInput } = require("../src/modules/purchases/suppliers.input.ts");
test("orders require an active tenant supplier and active catalog with minimum / multiple", async () => {
  let supplier = { isActive: true }; let catalog = [{ variantId: "sku", minOrderQty: 5, orderMultiple: 3 }];
  const tx = { supplier: { findFirst: async ({where}) => { assert.deepEqual(where, { id: "supplier", businessId: "tenant" }); return supplier; } }, supplierProduct: { findMany: async ({where}) => { assert.equal(where.businessId, "tenant"); assert.equal(where.supplierId, "supplier"); assert.equal(where.isActive, true); return catalog; } } };
  const run = orderedQty => validateSupplierOrder(tx, "tenant", "supplier", [{ variantId: "sku", orderedQty }]);
  await run(6);
  for (const qty of [3, 5, 7]) await assert.rejects(run(qty), err => err.statusCode === 400);
  catalog = []; await assert.rejects(run(6), err => err.statusCode === 400);
  supplier.isActive = false; await assert.rejects(run(6), err => err.statusCode === 409);
  supplier = null; await assert.rejects(run(6), err => err.statusCode === 404);
});
test("supplier profile normalizes blanks and protects document-owned debt", () => {
  assert.deepEqual(supplierInput({ name: "  NCC  ", phone: "  ", supplierCode: " NCC01 " }), { name: "NCC", phone: null, supplierCode: "NCC01" });
  assert.deepEqual(supplierInput({ email: null, isActive: false }, true), { email: null, isActive: false });
  for (const payload of [{ debtAmount: "100" }, { email: "invalid" }, { isActive: "false" }, {}]) assert.throws(() => supplierInput(payload, true), err => err.statusCode === 400);
});
