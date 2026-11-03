const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");
const { orderInput, receiptInput } = require("../src/modules/purchases/purchases.input.ts");
const D = (v) => new Prisma.Decimal(v);
const businessId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const variantId = "33333333-3333-4333-8333-333333333333";
const itemId = "44444444-4444-4444-8444-444444444444";
const supplierId = "55555555-5555-4555-8555-555555555555";
const calls = [];
let state;
let conflicts;
function clone(value) {
  if (Prisma.Decimal.isDecimal(value)) return D(value);
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  return value;
}
const tx = {
  cashShift: { findFirst: async () => state.shift },
  cashTransaction: { create: async ({ data }) => state.payments.push(data) },
  user: { findUnique: async () => ({ id: "actor", isActive: true }) },
  supplier: {
    findFirst: async ({ where }) => { calls.push(["supplierScope", where]); return state.supplier; },
    update: async ({ data }) => Object.assign(state.supplier, data),
    create: async ({ data }) => ({ id: supplierId, ...data }),
  },
  productVariant: {
    findMany: async ({ where }) => { calls.push(["variantScope", where]); return [state.variant]; },
    update: async ({ data }) => Object.assign(state.variant, data),
  },
  purchaseOrder: {
    findFirst: async ({ where }) => { calls.push(["orderScope", where]); return clone(state.order); },
    create: async ({ data }) => ({ id, ...data }),
    update: async ({ data }) => Object.assign(state.order, data),
  },
  purchaseOrderItem: { update: async ({ data }) => { state.order.purchaseOrderItems[0].receivedQty += data.receivedQty.increment; } },
  purchaseReceipt: {
    create: async ({ data }) => {
      if (state.codes.includes(data.receiptCode)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
      state.codes.push(data.receiptCode);
      state.receipt = { id, ...data };
      return state.receipt;
    },
    findFirst: async ({ where }) => { calls.push(["receiptScope", where]); return state.receipt; },
    findUniqueOrThrow: async () => state.receipt,
    update: async ({ data }) => Object.assign(state.receipt, data),
  },
  productLot: {
    findUnique: async () => state.lot,
    create: async ({ data }) => (state.lot = { id: "lot", ...data }),
  },
  inventoryBalance: {
    aggregate: async () => ({ _sum: { quantityOnHand: state.quantity } }),
    findFirst: async () => state.balance,
    create: async ({ data }) => { state.balance = { id: "balance", ...data }; state.quantity += data.quantityOnHand; },
    update: async ({ data }) => { state.quantity += data.quantityOnHand.increment; state.balance.quantityOnHand += data.quantityOnHand.increment; },
  },
  purchaseReceiptItem: { create: async ({ data }) => state.items.push(data) },
  inventoryLedger: { create: async ({ data }) => state.ledger.push(data) },
};
const db = {
  supplier: tx.supplier,
  $transaction: async (work, options) => {
    assert.equal(options.isolationLevel, "Serializable");
    const snapshot = clone(state);
    try {
      const result = await work(tx);
      if (conflicts-- > 0) throw Object.assign(new Error("conflict"), { code: "P2034" });
      return result;
    } catch (err) { state = snapshot; throw err; }
  },
};
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma: db } };
const { PurchasesWriteService } = require("../src/modules/purchases/purchases-write.service.ts");
const service = new PurchasesWriteService();
const receive = (extra = {}) => ({ receiptCode: "PR-001", paidAmount: "10.00", items: [{ poItemId: itemId, receivedQty: 2, actualCost: "20.00" }], ...extra });
beforeEach(() => {
  calls.length = 0; conflicts = 0;
  state = {
    supplier: { id: supplierId, debtAmount: D(0) },
    order: { id, supplierId, status: "ORDERED", purchaseOrderItems: [{ id: itemId, variantId, orderedQty: 5, receivedQty: 0, unitPrice: D(20) }] },
    variant: { id: variantId, isActive: true, costPrice: D(10), template: { hasLotTracking: false } },
    quantity: 10, balance: { id: "balance", quantityOnHand: 10 }, lot: null, receipt: null, items: [], ledger: [], codes: [],
    shift: { id }, payments: [],
  };
});

test("validates quantities, decimal precision, dates and duplicate order SKU", () => {
  const input = { poCode: "PO-1", supplierId, items: [{ variantId, orderedQty: 2, unitPrice: "10.00" }] };
  assert.equal(orderInput(input).items[0].unitPrice.toFixed(2), "10.00");
  for (const orderedQty of [0, -1, 1.5, "2", 2147483648]) assert.throws(() => orderInput({ ...input, items: [{ ...input.items[0], orderedQty }] }));
  assert.throws(() => orderInput({ ...input, items: [...input.items, ...input.items] }));
  assert.throws(() => receiptInput(receive({ paidAmount: "40.01" })));
  assert.throws(() => receiptInput(receive({ items: [{ poItemId: itemId, receivedQty: 1, actualCost: "1.001" }] })));
  assert.throws(() => orderInput({ ...input, orderDate: "2026-02-30" }));
});

test("create PO scopes supplier and SKU, records actor and leaves stock unchanged", async () => {
  const row = await service.createOrder(businessId, "auth", { poCode: "PO-1", supplierId, items: [{ variantId, orderedQty: 5, unitPrice: "20" }] });
  assert.equal(row.businessId, businessId); assert.equal(row.createdBy, "actor"); assert.equal(row.status, "ORDERED");
  assert.equal(calls[0][1].businessId, businessId); assert.equal(calls[1][1].businessId, businessId);
  assert.equal(state.quantity, 10); assert.equal(state.ledger.length, 0);
});

test("receiving updates stock, ledger, weighted cost, partial PO and supplier debt", async () => {
  await service.receiveOrder(businessId, "auth", id, receive());
  assert.equal(state.quantity, 12); assert.equal(state.variant.costPrice.toFixed(2), "11.67");
  assert.equal(state.order.status, "PARTIALLY_RECEIVED"); assert.equal(state.order.purchaseOrderItems[0].receivedQty, 2);
  assert.equal(state.supplier.debtAmount.toFixed(2), "30.00");
  assert.equal(state.ledger[0].balanceAfter, 12); assert.equal(state.ledger[0].referenceDocId, id);
  assert.equal(state.ledger[0].totalCostValue.toFixed(2), "40.00");
  assert.deepEqual(calls.find(([name]) => name === "orderScope")[1], { id, businessId });
});

test("second delivery completes PO; reused receipt code cannot add stock twice", async () => {
  await service.receiveOrder(businessId, "auth", id, receive());
  await assert.rejects(service.receiveOrder(businessId, "auth", id, receive()), (err) => err.code === "P2002");
  assert.equal(state.quantity, 12);
  await service.receiveOrder(businessId, "auth", id, receive({ receiptCode: "PR-002", items: [{ poItemId: itemId, receivedQty: 3, actualCost: "20" }] }));
  assert.equal(state.order.status, "COMPLETED"); assert.equal(state.quantity, 15);
});

test("rejects aggregate over-receipt across lots and foreign PO lines", async () => {
  for (const items of [
    [{ poItemId: itemId, receivedQty: 3, actualCost: "20" }, { poItemId: itemId, receivedQty: 3, actualCost: "20" }],
    [{ poItemId: variantId, receivedQty: 1, actualCost: "20" }],
  ]) await assert.rejects(service.receiveOrder(businessId, "auth", id, receive({ items })), (err) => err.statusCode === 400);
  assert.equal(state.quantity, 10); assert.equal(state.receipt, null);
});

test("missing lot dates or audit lock rolls back all receipt writes", async () => {
  state.variant.template.hasLotTracking = true;
  await assert.rejects(service.receiveOrder(businessId, "auth", id, receive()), (err) => err.statusCode === 400);
  assert.equal(state.receipt, null); assert.equal(state.codes.length, 0); assert.equal(state.quantity, 10);
  state.variant.isLockedForAudit = true;
  await assert.rejects(service.receiveOrder(businessId, "auth", id, receive()), (err) => err.statusCode === 409);
});

test("lot receipt stores dates; conflicting existing lot cannot be overwritten", async () => {
  state.variant.template.hasLotTracking = true;
  const input = receive({ items: [{ poItemId: itemId, receivedQty: 2, actualCost: "20", lotNumber: "LOT-1", expirationDate: "2027-01-01" }] });
  await service.receiveOrder(businessId, "auth", id, input);
  assert.equal(state.items[0].lotId, "lot"); assert.equal(state.lot.expirationDate.toISOString(), "2027-01-01T00:00:00.000Z");
  input.receiptCode = "PR-002"; input.items[0].expirationDate = "2027-02-01";
  await assert.rejects(service.receiveOrder(businessId, "auth", id, input), (err) => err.statusCode === 409);
  assert.equal(state.quantity, 12);
});

test("cumulative payment reduces debt once and rejects overpayment/decreasing payment", async () => {
  await service.receiveOrder(businessId, "auth", id, receive());
  await service.updatePayment(businessId, "auth", id, { paidAmount: "25.00" });
  assert.equal(state.supplier.debtAmount.toFixed(2), "15.00");
  await service.updatePayment(businessId, "auth", id, { paidAmount: "25.00" });
  assert.equal(state.supplier.debtAmount.toFixed(2), "15.00");
  for (const paidAmount of ["24.00", "40.01"]) await assert.rejects(service.updatePayment(businessId, "auth", id, { paidAmount }), (err) => err.statusCode === 400);
  assert.equal(state.receipt.paidAmount.toFixed(2), "25.00");
  assert.equal(state.payments.length, 2);
  assert.equal(state.payments[0].amount.toFixed(2), "10.00");
  assert.equal(state.payments[1].amount.toFixed(2), "15.00");
  assert.deepEqual(calls.find(([name]) => name === "receiptScope")[1], { id, businessId });
});

test("late failure rolls stock/PO/ledger back; serialization retry applies once", async () => {
  state.supplier = null;
  await assert.rejects(service.receiveOrder(businessId, "auth", id, receive()), (err) => err.statusCode === 404);
  assert.equal(state.quantity, 10);
  state.supplier = { id: supplierId, debtAmount: D("9999999999.99") };
  await assert.rejects(service.receiveOrder(businessId, "auth", id, receive()), (err) => err.statusCode === 400);
  assert.equal(state.quantity, 10); assert.equal(state.ledger.length, 0); assert.equal(state.receipt, null);
  state.supplier.debtAmount = D(0); conflicts = 1;
  await service.receiveOrder(businessId, "auth", id, receive());
  assert.equal(state.quantity, 12); assert.equal(state.ledger.length, 1); assert.equal(state.supplier.debtAmount.toFixed(2), "30.00");
});

test("split SKU lines preserve unrounded weighted values until final cost", async () => {
  state.quantity = 1; state.balance.quantityOnHand = 1; state.variant.costPrice = D("0.01");
  await service.receiveOrder(businessId, "auth", id, receive({ paidAmount: "0", items: [
    { poItemId: itemId, receivedQty: 1, actualCost: "0" },
    { poItemId: itemId, receivedQty: 1, actualCost: "0" },
  ] }));
  assert.equal(state.quantity, 3); assert.equal(state.variant.costPrice.toFixed(2), "0.00");
  assert.equal(state.ledger.length, 2);
});

test("closed PO, cancelled receipt and missing documents cannot be mutated", async () => {
  for (const status of ["COMPLETED", "CLOSED_SHORT", "CANCELLED"]) {
    state.order.status = status;
    await assert.rejects(service.receiveOrder(businessId, "auth", id, receive()), (err) => err.statusCode === 409);
  }
  state.order = null;
  await assert.rejects(service.receiveOrder(businessId, "auth", id, receive()), (err) => err.statusCode === 404);
  await assert.rejects(service.updatePayment(businessId, "auth", id, { paidAmount: "1" }), (err) => err.statusCode === 404);
  state.receipt = { status: "CANCELLED", totalAmount: D(10), paidAmount: D(0) };
  await assert.rejects(service.updatePayment(businessId, "auth", id, { paidAmount: "1" }), (err) => err.statusCode === 409);
  assert.equal(state.quantity, 10);
});

test("serialization conflicts stop after three tries with no partial writes", async () => {
  conflicts = 5;
  await assert.rejects(service.receiveOrder(businessId, "auth", id, receive()), (err) => err.statusCode === 409);
  assert.equal(conflicts, 2); assert.equal(state.quantity, 10); assert.equal(state.ledger.length, 0);
});

test("nonzero payments require an open user shift and rollback the receipt otherwise", async () => {
  state.shift = null;
  await assert.rejects(service.receiveOrder(businessId, "auth", id, receive()), (err) => err.statusCode === 409);
  assert.equal(state.receipt, null); assert.equal(state.quantity, 10); assert.equal(state.payments.length, 0);
  await service.receiveOrder(businessId, "auth", id, receive({ paidAmount: "0" }));
  assert.equal(state.quantity, 12); assert.equal(state.payments.length, 0);
});

test("changed draft fingerprint fails before receipt or payment creation", async () => {
  await assert.rejects(service.receiveOrder(businessId, "auth", id, receive(), "stale-fingerprint"), (err) => err.statusCode === 409);
  assert.equal(state.quantity, 10); assert.equal(state.receipt, null); assert.equal(state.payments.length, 0);
});

test("signed draft confirmation enters the real receiving transaction exactly once", async () => {
  const { signDraft, purchasesDraftsService } = require("../src/modules/purchases/purchases-drafts.service.ts");
  const { orderFingerprint } = require("../src/modules/purchases/purchases-fingerprint.ts");
  const previousKey = process.env.PURCHASE_DRAFT_SECRET;
  process.env.PURCHASE_DRAFT_SECRET = "test-confirmation-key-at-least-32-characters";
  try {
    const draftToken = signDraft({ version: 1, businessId, authUserId: "auth", orderId: id, orderFingerprint: orderFingerprint(state.order), expiresAt: Date.now() + 3600000, receipt: receive() });
    await purchasesDraftsService.confirm(businessId, "auth", id, { draftToken });
    assert.equal(state.quantity, 12); assert.equal(state.payments.length, 1); assert.equal(state.ledger.length, 1);
    await assert.rejects(purchasesDraftsService.confirm(businessId, "auth", id, { draftToken }), (err) => err.statusCode === 409);
    assert.equal(state.quantity, 12); assert.equal(state.payments.length, 1);
  } finally {
    if (previousKey === undefined) delete process.env.PURCHASE_DRAFT_SECRET; else process.env.PURCHASE_DRAFT_SECRET = previousKey;
  }
});

test("draft confirmation revalidates expiration before committing inventory/payment", async () => {
  const { signDraft, purchasesDraftsService } = require("../src/modules/purchases/purchases-drafts.service.ts");
  const { orderFingerprint } = require("../src/modules/purchases/purchases-fingerprint.ts");
  const previousKey = process.env.PURCHASE_DRAFT_SECRET;
  process.env.PURCHASE_DRAFT_SECRET = "test-confirmation-key-at-least-32-characters";
  state.variant.template.hasLotTracking = true;
  try {
    const receipt = receive({ items: [{ poItemId: itemId, receivedQty: 2, actualCost: "20", lotNumber: "OLD", expirationDate: "2000-01-01" }] });
    const draftToken = signDraft({ version: 1, businessId, authUserId: "auth", orderId: id, orderFingerprint: orderFingerprint(state.order), expiresAt: Date.now() + 3600000, receipt });
    await assert.rejects(purchasesDraftsService.confirm(businessId, "auth", id, { draftToken }), (err) => err.statusCode === 400);
    assert.equal(state.quantity, 10); assert.equal(state.receipt, null); assert.equal(state.payments.length, 0);
  } finally {
    if (previousKey === undefined) delete process.env.PURCHASE_DRAFT_SECRET; else process.env.PURCHASE_DRAFT_SECRET = previousKey;
  }
});
