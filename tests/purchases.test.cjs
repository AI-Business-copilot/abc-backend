const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");
const { filters, uuid } = require("../src/modules/purchases/purchases.query.ts");

const calls = [];
let order;
let receipt;
const db = {
  purchaseOrder: {
    findFirst: async (args) => { calls.push(["order", args]); return order; },
    findMany: async (args) => { calls.push(["orders", args]); return []; },
    count: async (args) => { calls.push(["orderCount", args]); return 0; },
  },
  purchaseReceipt: {
    findFirst: async (args) => { calls.push(["receipt", args]); return receipt; },
    findMany: async (args) => { calls.push(["receipts", args]); return []; },
    count: async (args) => { calls.push(["receiptCount", args]); return 0; },
  },
  supplier: {
    findMany: async (args) => { calls.push(["suppliers", args]); return []; },
    count: async (args) => { calls.push(["supplierCount", args]); return 0; },
  },
  inventoryLedger: { findMany: async (args) => { calls.push(["ledger", args]); return []; } },
  $transaction: async (operation) => typeof operation === "function" ? operation(db) : Promise.all(operation),
};
// Replace only the database boundary: no credentials or live DB are used.
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma: db } };
const { PurchasesService } = require("../src/modules/purchases/purchases.service.ts");
const service = new PurchasesService();
const id = "11111111-1111-4111-8111-111111111111";
const businessId = "22222222-2222-4222-8222-222222222222";
const money = (value) => new Prisma.Decimal(value);
beforeEach(() => { calls.length = 0; order = undefined; receipt = undefined; });

test("rejects invalid paging, UUID, status and dates before querying", () => {
  for (const query of [
    { page: "1.5" }, { page: "0" }, { pageSize: "101" }, { pageSize: ["2"] },
    { supplierId: "bad" }, { status: "DRAFT" }, { from: "2026-02-30" },
    { from: "2026-10-29", to: "2026-10-28" }, { search: {} },
  ]) assert.throws(() => filters(query, ["ORDERED"]), (err) => err.statusCode === 400);
  assert.throws(() => uuid("bad", "id"), (err) => err.statusCode === 400);
  assert.equal(calls.length, 0);
});

test("list queries scope rows AND counts to business and retain filters", async () => {
  await service.listOrders(businessId, { supplierId: id, status: "ordered", from: "2026-10-01", to: "2026-10-28", search: "SKU", page: "2", pageSize: "5" });
  const args = calls[0][1];
  assert.equal(args.where.businessId, businessId);
  assert.equal(args.where.supplierId, id);
  assert.equal(args.where.status, "ORDERED");
  assert.equal(args.where.orderDate.lt.toISOString(), "2026-10-29T00:00:00.000Z");
  assert.equal(args.skip, 5);
  assert.equal(args.take, 5);
  assert.equal(args.where.OR[2].purchaseOrderItems.some.variant.sku.contains, "SKU");
  assert.deepEqual(calls[1][1].where, args.where);
  await service.listReceipts(businessId, { poId: id, status: "RECEIVED" });
  assert.equal(calls[2][1].where.poId, id);
  assert.equal(calls[2][1].where.businessId, businessId);
  assert.deepEqual(calls[3][1].where, calls[2][1].where);
  await service.listSuppliers(businessId, { search: "vendor" });
  assert.equal(calls[4][1].where.businessId, businessId);
  assert.deepEqual(calls[5][1].where, calls[4][1].where);
});

test("PO totals preserve decimals, partial receipts and cancelled history", async () => {
  order = {
    id, purchaseOrderItems: [{ orderedQty: 10, receivedQty: 4, unitPrice: money("0.10") }],
    purchaseReceipts: [
      { status: "RECEIVED", totalAmount: money("0.30"), paidAmount: money("0.10") },
      { status: "RECEIVED", totalAmount: money("0.10"), paidAmount: money("0.10") },
      { status: "CANCELLED", totalAmount: money("50"), paidAmount: money("20") },
    ],
  };
  const result = await service.getOrder(businessId, id);
  assert.deepEqual(result.totals, { orderedQty: 10, receivedQty: 4, orderedAmount: "1.00", receivedAmount: "0.40", paidAmount: "0.20", debtAmount: "0.20" });
  assert.equal(result.purchaseOrderItems[0].remainingQty, 6);
  assert.equal(result.purchaseReceipts.length, 3);
  assert.deepEqual(calls[0][1].where, { id, businessId });
});

test("missing or other-business documents return 404 without reading ledger", async () => {
  await assert.rejects(service.getOrder(businessId, id), (err) => err.statusCode === 404);
  await assert.rejects(service.getReceipt(businessId, id), (err) => err.statusCode === 404);
  assert.deepEqual(calls[1][1].where, { id, businessId });
  assert.equal(calls.some(([name]) => name === "ledger"), false);
});

test("receipt supports standalone receipt, lot detail and scoped receipt ledger", async () => {
  receipt = {
    id, po: null, totalAmount: money("0.30"), paidAmount: money("0.10"),
    purchaseReceiptItems: [{ receivedQty: 3, actualCost: money("0.10"), lot: { lotNumber: "LOT-1" } }],
  };
  const result = await service.getReceipt(businessId, id);
  assert.equal(result.po, null);
  assert.equal(result.debtAmount, "0.20");
  assert.equal(result.purchaseReceiptItems[0].subtotal, "0.30");
  assert.equal(result.purchaseReceiptItems[0].lot.lotNumber, "LOT-1");
  assert.deepEqual(calls[1][1].where, { businessId, referenceDocId: id, OR: [
    { transactionType: "PURCHASE_RECEIPT" }, { referenceDocType: "PURCHASE_RECEIPT_CORRECTION" },
  ] });
});
