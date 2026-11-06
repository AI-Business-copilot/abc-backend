const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");
const D = (n) => new Prisma.Decimal(n);
const id = "11111111-1111-4111-8111-111111111111";
const businessId = "22222222-2222-4222-8222-222222222222";
let shift, receipt, payments;
const calls = [];
const tx = {
  $queryRaw: async () => [{ id }],
  user: { findUnique: async () => ({ id, status: "ACTIVE" }) },
  cashShift: {
    findFirst: async ({ where }) => { calls.push(["shift", where]); return shift; },
    create: async ({ data }) => (shift = { id, ...data }),
  },
  cashTransaction: {
    create: async ({ data }) => payments.push(data),
    findMany: async ({ where }) => { calls.push(["history", where]); return payments; },
  },
  purchaseReceipt: { findFirst: async ({ where }) => { calls.push(["receipt", where]); return receipt; } },
};
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma: { ...tx, $transaction: (work) => work(tx) } } };
const { PurchasesPaymentsService, recordSupplierPayment } = require("../src/modules/purchases/purchases-payments.service.ts");
const service = new PurchasesPaymentsService();
beforeEach(() => { calls.length = 0; shift = null; receipt = { paidAmount: D(30) }; payments = []; });

test("opening shift reuses existing open shift for current business/user", async () => {
  const first = await service.openShift(businessId, "auth", { openingCash: "100" });
  const second = await service.openShift(businessId, "auth", { openingCash: "500" });
  assert.equal(first.id, second.id); assert.equal(second.openingCash.toFixed(2), "100.00");
  assert.deepEqual(calls[0][1], { businessId, userId: id, status: "OPEN" });
});

test("recorded payment is linked to user-owned open shift and receipt", async () => {
  shift = { id };
  await recordSupplierPayment(tx, businessId, id, id, D(20), id);
  assert.deepEqual(calls[0][1], { id, businessId, userId: id, status: "OPEN" });
  assert.equal(payments[0].refDocId, id); assert.equal(payments[0].category, "SUPPLIER_PAYMENT");
  assert.equal(payments[0].transactionType, "OUT"); assert.equal(payments[0].createdBy, id);
});

test("history reports legacy missing events without inventing payment dates", async () => {
  payments = [{ id, amount: D(10) }];
  let result = await service.history(businessId, id);
  assert.equal(result.historyComplete, false); assert.equal(result.untrackedPaidAmount, "20.00");
  payments.push({ id: businessId, amount: D(20) });
  result = await service.history(businessId, id);
  assert.equal(result.historyComplete, true); assert.equal(result.untrackedPaidAmount, "0.00");
  assert.deepEqual(calls[0][1], { id, businessId });
  assert.equal(calls[1][1].businessId, businessId);
});

test("zero delta adds no event; missing shift or receipt fails", async () => {
  await recordSupplierPayment(tx, businessId, id, id, D(0)); assert.equal(payments.length, 0);
  await assert.rejects(recordSupplierPayment(tx, businessId, id, id, D(1)), (err) => err.statusCode === 409);
  receipt = null;
  await assert.rejects(service.history(businessId, id), (err) => err.statusCode === 404);
});
