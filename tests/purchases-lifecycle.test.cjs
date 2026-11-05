const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");
const D = (n) => new Prisma.Decimal(n);
const id = "11111111-1111-4111-8111-111111111111";
const businessId = "22222222-2222-4222-8222-222222222222";
const variantId = "33333333-3333-4333-8333-333333333333";
let order, supplier, receiptCount, receiptSum, returnSum;
const calls = [];
const tx = {
  user: { findUnique: async () => ({ id, isActive: true }) },
  supplier: {
    findFirst: async ({ where }) => { calls.push(["supplier", where]); return supplier; },
    update: async ({ data }) => { calls.push(["debtWrite", data]); supplier.debtAmount = data.debtAmount; return supplier; },
  },
  purchaseOrder: {
    findFirst: async ({ where }) => { calls.push(["order", where]); return order; },
    update: async ({ data }) => { calls.push(["orderWrite", data]); return { ...order, ...data }; },
  },
  supplierProduct: { findMany: async () => [{ variantId, minOrderQty: 1, orderMultiple: 1, isActive: true }] },
  productVariant: { findMany: async ({ where }) => { calls.push(["variants", where]); return [{ id: variantId }]; } },
  purchaseOrderItem: {
    deleteMany: async ({ where }) => calls.push(["deleteItems", where]),
    update: async ({ where, data }) => calls.push(["updateItem", { where, data }]),
    create: async ({ data }) => calls.push(["createItem", data]),
  },
  purchaseReceipt: {
    count: async () => receiptCount,
    aggregate: async ({ where }) => { calls.push(["receipts", where]); return { _sum: receiptSum }; },
  },
  vendorReturn: { aggregate: async ({ where }) => { calls.push(["returns", where]); return { _sum: { totalReturnValue: returnSum } }; } },
};
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma: { $transaction: (work) => work(tx) } } };
const { PurchasesLifecycleService } = require("../src/modules/purchases/purchases-lifecycle.service.ts");
const { assertUsableLot } = require("../src/modules/purchases/purchases-write.service.ts");
const service = new PurchasesLifecycleService();
beforeEach(() => {
  calls.length = 0; receiptCount = 0;
  order = { id, businessId, supplierId: id, poCode: "PO-1", status: "ORDERED", orderDate: new Date("2026-10-01"), expectedDeliveryDate: new Date("2026-10-02"),
    purchaseOrderItems: [{ id, variantId, orderedQty: 10, receivedQty: 0, unitPrice: D(20) }] };
  supplier = { id, isActive: true, debtAmount: D(90) }; receiptSum = { totalAmount: D(100), paidAmount: D(30) }; returnSum = D(10);
});

test("PO update preserves existing item IDs and scopes lookups", async () => {
  await service.updateOrder(businessId, "auth", id, { items: [{ variantId, orderedQty: 15, unitPrice: "25" }] });
  assert.deepEqual(calls.find(([key]) => key === "order")[1], { id, businessId });
  assert.equal(calls.find(([key]) => key === "supplier")[1].businessId, businessId);
  assert.equal(calls.find(([key]) => key === "variants")[1].businessId, businessId);
  const update = calls.find(([key]) => key === "updateItem")[1];
  assert.equal(update.where.id, id); assert.equal(update.data.orderedQty, 15);
  assert.equal(update.data.unitPrice.toFixed(2), "25.00");
  assert.equal(calls.some(([key]) => key === "createItem"), false);
});

test("PO edits require delivery date for legacy orders and cannot clear an existing date", async () => {
  for (const expectedDeliveryDate of [null, ""]) {
    await assert.rejects(service.updateOrder(businessId, "auth", id, { expectedDeliveryDate }), (err) => err.statusCode === 400);
  }
  order.expectedDeliveryDate = null;
  await assert.rejects(service.updateOrder(businessId, "auth", id, { poCode: "PO-2" }), (err) => err.statusCode === 400);
  assert.equal(calls.some(([key]) => ["updateItem", "deleteItems", "orderWrite"].includes(key)), false);
  const saved = await service.updateOrder(businessId, "auth", id, { expectedDeliveryDate: "2026-10-01" });
  assert.equal(saved.expectedDeliveryDate.toISOString().slice(0, 10), "2026-10-01");
});

test("editing received PO, unknown fields or invalid dates fails before writes", async () => {
  for (const patch of [{ status: "CANCELLED" }, {}, { expectedDeliveryDate: "2026-09-01" }]) {
    await assert.rejects(service.updateOrder(businessId, "auth", id, patch), (err) => err.statusCode === 400);
  }
  receiptCount = 1;
  await assert.rejects(service.updateOrder(businessId, "auth", id, { poCode: "PO-2" }), (err) => err.statusCode === 409);
  assert.equal(calls.some(([key]) => ["updateItem", "deleteItems", "orderWrite"].includes(key)), false);
});

test("cancel only unreceived orders and allow repeating cancellation", async () => {
  assert.equal((await service.finishOrder(businessId, "auth", id, "cancel")).status, "CANCELLED");
  order.status = "CANCELLED";
  assert.equal((await service.finishOrder(businessId, "auth", id, "cancel")).status, "CANCELLED");
  order.status = "PARTIALLY_RECEIVED"; order.purchaseOrderItems[0].receivedQty = 4;
  await assert.rejects(service.finishOrder(businessId, "auth", id, "cancel"), (err) => err.statusCode === 409);
});

test("close short only partial orders and preserve receipt quantities", async () => {
  await assert.rejects(service.finishOrder(businessId, "auth", id, "close"), (err) => err.statusCode === 409);
  order.status = "PARTIALLY_RECEIVED"; order.purchaseOrderItems[0].receivedQty = 4;
  const result = await service.finishOrder(businessId, "auth", id, "close");
  assert.equal(result.status, "CLOSED_SHORT"); assert.equal(result.purchaseOrderItems[0].receivedQty, 4);
  order.status = "COMPLETED";
  await assert.rejects(service.finishOrder(businessId, "auth", id, "close"), (err) => err.statusCode === 409);
});

test("debt preview includes received receipts and completed return credits without writing", async () => {
  const result = await service.reconcileDebt(businessId, "auth", id);
  assert.equal(result.storedDebtAmount, "90.00"); assert.equal(result.calculatedDebtAmount, "60.00");
  assert.equal(result.difference, "-30.00"); assert.equal(result.applied, false);
  assert.equal(calls.find(([key]) => key === "receipts")[1].status, "RECEIVED");
  assert.equal(calls.find(([key]) => key === "returns")[1].status, "COMPLETED");
  assert.equal(calls.some(([key]) => key === "debtWrite"), false);
});

test("debt apply requires explicit intent and rejects stale preview", async () => {
  await assert.rejects(service.reconcileDebt(businessId, "auth", id, {}), (err) => err.statusCode === 400);
  await assert.rejects(service.reconcileDebt(businessId, "auth", id, { apply: true, expectedDebtAmount: "80" }), (err) => err.statusCode === 409);
  const result = await service.reconcileDebt(businessId, "auth", id, { apply: true, expectedDebtAmount: "90" });
  assert.equal(result.applied, true); assert.equal(supplier.debtAmount.toFixed(2), "60.00");
});

test("expired lot validation uses Vietnam date and allows expiration day", () => {
  const now = new Date("2026-10-28T18:00:00Z"); // 01:00 Oct 29 Vietnam
  assert.throws(() => assertUsableLot(new Date("2026-10-28"), now), (err) => err.statusCode === 400);
  assert.doesNotThrow(() => assertUsableLot(new Date("2026-10-29"), now));
});

test("foreign/missing PO and supplier return 404", async () => {
  order = null;
  await assert.rejects(service.finishOrder(businessId, "auth", id, "cancel"), (err) => err.statusCode === 404);
  supplier = null;
  await assert.rejects(service.reconcileDebt(businessId, "auth", id), (err) => err.statusCode === 404);
});

test("unchanged legacy lines allow document edits after supplier retirement, buying changes fail", async () => {
  supplier.isActive = false;
  const saved = await service.updateOrder(businessId, "auth", id, { expectedDeliveryDate: "2026-10-03" });
  assert.equal(saved.expectedDeliveryDate.toISOString().slice(0, 10), "2026-10-03");
  await assert.rejects(service.updateOrder(businessId, "auth", id, { items: [{ variantId, orderedQty: 15, unitPrice: "25" }] }), err => err.statusCode === 409);
});
