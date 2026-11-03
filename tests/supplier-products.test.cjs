const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");
const businessId = "11111111-1111-4111-8111-111111111111";
const supplierId = "22222222-2222-4222-8222-222222222222";
const variantId = "33333333-3333-4333-8333-333333333333";
let supplier; let variant; let rows; let calls; let databaseError;
const db = {
  supplier: { findFirst: async (args) => { calls.push(["supplier", args]); return supplier; } },
  productVariant: {
    findFirst: async (args) => { calls.push(["variant", args]); return variant; },
    findMany: async (args) => { calls.push(["products", args]); if (databaseError) throw databaseError; return rows; },
    count: async (args) => { calls.push(["count", args]); return rows.length; },
  },
  supplierProduct: {
    upsert: async (args) => { calls.push(["save", args]); if (databaseError) throw databaseError; return args.create; },
    deleteMany: async (args) => { calls.push(["delete", args]); if (databaseError) throw databaseError; return { count: 1 }; },
  },
  $transaction: async (operation) => operation(db),
};
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma: db } };
const { SupplierProductsService } = require("../src/modules/purchases/supplier-products.service.ts");
const service = new SupplierProductsService();
beforeEach(() => { supplier = { id: supplierId }; variant = { id: variantId }; rows = []; calls = []; databaseError = undefined; });

test("missing supplier product schema reports unavailability for reads and writes", async () => {
  databaseError = new Prisma.PrismaClientKnownRequestError('The table public.supplier_products does not exist.', { code: "P2021", clientVersion: Prisma.prismaVersion.client });
  const unavailable = (err) => err.statusCode === 503 && err.message.includes("chưa được kích hoạt");
  await assert.rejects(service.list(businessId, supplierId, {}), unavailable);
  await assert.rejects(service.list(businessId, supplierId, { kind: "history" }), unavailable);
  await assert.rejects(service.save(businessId, supplierId, { variantId, supplyPrice: "10" }), unavailable);
  await assert.rejects(service.remove(businessId, supplierId, variantId), unavailable);
});

test("other database failures are preserved instead of being hidden as missing setup", async () => {
  for (const [code, message] of [["P2021", "The table public.product_variants does not exist."], ["P2002", "supplier_products unique constraint failed"]]) {
    databaseError = new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: Prisma.prismaVersion.client });
    await assert.rejects(service.list(businessId, supplierId, {}), (err) => err === databaseError);
  }
});

test("foreign or missing suppliers and SKUs cannot be linked or read", async () => {
  supplier = null;
  await assert.rejects(service.list(businessId, supplierId, {}), (err) => err.statusCode === 404);
  await assert.rejects(service.save(businessId, supplierId, { variantId, supplyPrice: "10" }), (err) => err.statusCode === 404);
  assert.deepEqual(calls[0][1].where, { id: supplierId, businessId });
  assert.equal(calls.some(([name]) => name === "products" || name === "save"), false);
  supplier = { id: supplierId }; variant = null;
  await assert.rejects(service.save(businessId, supplierId, { variantId, supplyPrice: "10" }), (err) => err.statusCode === 404);
  assert.deepEqual(calls.at(-1)[1].where, { id: variantId, businessId, isActive: true });
});

test("catalog queries page only this supplier's SKU links and preserve exact prices", async () => {
  rows = [{ id: variantId, sku: "SKU", isActive: true, costPrice: new Prisma.Decimal("0.10"),
    template: { name: "Product", hasLotTracking: false }, inventoryBalances: [{ quantityOnHand: 3 }],
    supplierProducts: [{ supplyPrice: new Prisma.Decimal("0.20") }], purchaseReceiptItems: [],
  }];
  const result = await service.list(businessId, supplierId, { page: "2", pageSize: "5", search: "SKU" });
  const args = calls.find(([name]) => name === "products")[1];
  assert.equal(args.where.businessId, businessId);
  assert.deepEqual(args.where.supplierProducts.some, { businessId, supplierId });
  assert.equal(args.skip, 5); assert.equal(args.take, 5);
  assert.deepEqual(calls.find(([name]) => name === "count")[1].where, args.where);
  assert.equal(result.items[0].supplyPrice, "0.20");
  assert.equal(result.items[0].onHand, 3); assert.equal(result.items[0].lastPurchase, null);
});

test("history excludes cancelled receipts and does not invent a catalog entry", async () => {
  rows = [{ id: variantId, sku: "OLD", isActive: false, costPrice: null,
    template: { name: "Old product", hasLotTracking: false }, inventoryBalances: [], supplierProducts: [],
    purchaseReceiptItems: [{ actualCost: new Prisma.Decimal("123.45"), receivedQty: 8,
      receipt: { id: "receipt", receiptCode: "PR", receivedAt: new Date("2026-11-03") } }],
  }];
  const result = await service.list(businessId, supplierId, { kind: "history" });
  const args = calls.find(([name]) => name === "products")[1];
  const scopedReceipts = { businessId, supplierId, status: "RECEIVED" };
  assert.deepEqual(args.where.purchaseReceiptItems.some.receipt, scopedReceipts);
  assert.deepEqual(args.include.purchaseReceiptItems.where.receipt, scopedReceipts);
  assert.equal(args.include.purchaseReceiptItems.take, 1);
  assert.equal(result.items[0].supplyPrice, null);
  assert.equal(result.items[0].lastPurchase.actualCost, "123.45");
  assert.equal(result.items[0].isActive, false);
});

test("updating quoted price and removal are tenant scoped without modifying receipt history", async () => {
  await service.save(businessId, supplierId, { variantId, supplyPrice: "123.45" });
  const saved = calls.find(([name]) => name === "save")[1];
  assert.deepEqual(saved.where.businessId_supplierId_variantId, { businessId, supplierId, variantId });
  assert.equal(saved.update.supplyPrice.toFixed(2), "123.45");
  await service.remove(businessId, supplierId, variantId);
  assert.deepEqual(calls.at(-1), ["delete", { where: { businessId, supplierId, variantId } }]);
});

test("invalid prices, list kinds, pagination and UUIDs fail before database access", async () => {
  for (const supplyPrice of ["-1", "0.001", "10000000000", "NaN", {}]) {
    await assert.rejects(service.save(businessId, supplierId, { variantId, supplyPrice }), (err) => err.statusCode === 400);
  }
  for (const query of [{ kind: "anything" }, { pageSize: "101" }, { page: "0" }]) {
    await assert.rejects(service.list(businessId, supplierId, query), (err) => err.statusCode === 400);
  }
  await assert.rejects(service.remove(businessId, supplierId, "invalid"), (err) => err.statusCode === 400);
  assert.equal(calls.length, 0);
});
