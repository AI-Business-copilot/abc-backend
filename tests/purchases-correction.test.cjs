const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");
const D = (n) => new Prisma.Decimal(n);
const id = "11111111-1111-4111-8111-111111111111";
const businessId = "22222222-2222-4222-8222-222222222222";
let state;
const calls = [];
function clone(v) {
  if (Prisma.Decimal.isDecimal(v)) return D(v);
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}
const tx = {
  user: { findUnique: async () => ({ id, isActive: true }) },
  purchaseReceipt: {
    findFirst: async ({ where }) => { calls.push(where); return clone(state.receipt); },
    update: async ({ data }) => Object.assign(state.receipt, data),
  },
  purchaseReceiptItem: { update: async ({ data }) => Object.assign(state.receipt.purchaseReceiptItems[0], data) },
  purchaseOrder: { findFirst: async () => clone(state.order), update: async ({ data }) => Object.assign(state.order, data) },
  purchaseOrderItem: { update: async ({ data }) => { state.order.purchaseOrderItems[0].receivedQty += data.receivedQty.increment; } },
  vendorReturn: { count: async () => state.returnCount },
  supplier: { findFirst: async () => state.supplier, update: async ({ data }) => Object.assign(state.supplier, data) },
  productVariant: { findFirst: async () => clone(state.variant), update: async ({ data }) => Object.assign(state.variant, data) },
  inventoryBalance: {
    aggregate: async () => ({ _sum: { quantityOnHand: state.balance.quantityOnHand } }),
    findFirst: async () => state.balance,
    update: async ({ data }) => { state.balance.quantityOnHand += data.quantityOnHand.increment; },
  },
  inventoryLedger: {
    findFirst: async () => state.latest,
    aggregate: async () => ({ _sum: { quantityChanged: state.ledgerQuantity } }),
    create: async ({ data }) => { state.ledger.push(data); state.latest = data; state.ledgerQuantity += data.quantityChanged; },
  },
};
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma: {
  $transaction: async (work) => { const snapshot = clone(state); try { return await work(tx); } catch (err) { state = snapshot; throw err; } },
} } };
const { PurchasesCorrectionService } = require("../src/modules/purchases/purchases-correction.service.ts");
const service = new PurchasesCorrectionService();
const input = (receivedQty = 3, actualCost = "12") => ({ expectedTotalAmount: "40", items: [{ id, receivedQty, actualCost, expectedReceivedQty: 4, expectedActualCost: "10" }] });
beforeEach(() => {
  calls.length = 0;
  state = {
    receipt: { id, poId: id, supplierId: id, status: "RECEIVED", totalAmount: D(40), paidAmount: D(10),
      purchaseReceiptItems: [{ id, poItemId: id, variantId: id, lotId: null, receivedQty: 4, actualCost: D(10) }] },
    order: { id, status: "PARTIALLY_RECEIVED", purchaseOrderItems: [{ id, orderedQty: 10, receivedQty: 4 }] },
    variant: { costPrice: D(10), isLockedForAudit: false }, balance: { id, quantityOnHand: 4, damagedQuantity: 0 },
    supplier: { id, debtAmount: D(30) }, latest: { referenceDocId: id, referenceDocType: "PURCHASE_RECEIPT", balanceAfter: 4 },
    ledgerQuantity: 4, returnCount: 0, ledger: [],
  };
});

test("correction changes quantity, actual price, PO, stock, value and debt atomically", async () => {
  const result = await service.correctReceipt(businessId, "auth", id, input());
  assert.equal(result.totalAmount.toFixed(2), "36.00"); assert.equal(result.debtAmount, "26.00");
  assert.equal(state.balance.quantityOnHand, 3); assert.equal(state.variant.costPrice.toFixed(2), "12.00");
  assert.equal(state.order.purchaseOrderItems[0].receivedQty, 3); assert.equal(state.supplier.debtAmount.toFixed(2), "26.00");
  assert.equal(state.ledger[0].quantityChanged, -1); assert.equal(state.ledger[0].totalCostValue.toFixed(2), "-4.00");
  assert.equal(state.ledger[0].referenceDocType, "PURCHASE_RECEIPT_CORRECTION");
  assert.deepEqual(calls[0], { id, businessId });
});

test("price-only correction keeps quantity and records signed value change", async () => {
  await service.correctReceipt(businessId, "auth", id, input(4, "11"));
  assert.equal(state.balance.quantityOnHand, 4); assert.equal(state.variant.costPrice.toFixed(2), "11.00");
  assert.equal(state.ledger[0].quantityChanged, 0); assert.equal(state.ledger[0].totalCostValue.toFixed(2), "4.00");
});

test("correction rejects stale totals, over-receipt, foreign lines and totals below payments", async () => {
  for (const body of [
    { ...input(), expectedTotalAmount: "30" }, input(11), input(1, "1"),
    { ...input(), items: [{ id: businessId, receivedQty: 3, actualCost: "12" }] },
  ]) await assert.rejects(service.correctReceipt(businessId, "auth", id, body));
  assert.equal(state.balance.quantityOnHand, 4); assert.equal(state.ledger.length, 0);
});

test("later movements, audit lock, vendor returns or inconsistent inventory block correction", async () => {
  state.latest.referenceDocId = businessId;
  await assert.rejects(service.correctReceipt(businessId, "auth", id, input()), (err) => err.statusCode === 409);
  state.latest.referenceDocId = id; state.variant.isLockedForAudit = true;
  await assert.rejects(service.correctReceipt(businessId, "auth", id, input()), (err) => err.statusCode === 409);
  state.variant.isLockedForAudit = false; state.returnCount = 1;
  await assert.rejects(service.correctReceipt(businessId, "auth", id, input()), (err) => err.statusCode === 409);
  state.returnCount = 0; state.ledgerQuantity = 3;
  await assert.rejects(service.correctReceipt(businessId, "auth", id, input()), (err) => err.statusCode === 409);
  assert.equal(state.balance.quantityOnHand, 4);
});

test("failure after inventory writes rolls everything back", async () => {
  state.supplier.debtAmount = D("9999999999.99");
  await assert.rejects(service.correctReceipt(businessId, "auth", id, input(4, "11")), (err) => err.statusCode === 400);
  assert.equal(state.balance.quantityOnHand, 4); assert.equal(state.variant.costPrice.toFixed(2), "10.00");
  assert.equal(state.receipt.totalAmount.toFixed(2), "40.00"); assert.equal(state.ledger.length, 0);
});
