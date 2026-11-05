const assert = require("node:assert/strict");
const { test, beforeEach, after } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");
const id = "11111111-1111-4111-8111-111111111111";
const businessId = "22222222-2222-4222-8222-222222222222";
const D = (n) => new Prisma.Decimal(n);
let order;
const calls = [];
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma: {
  purchaseOrder: { findFirst: async ({ where }) => { calls.push(where); return order; } },
  productVariant: { findMany: async () => [{ id, isActive: true, isLockedForAudit: false, template: { hasLotTracking: false } }] },
} } };
const { PurchasesDraftsService, signDraft, verifyDraft } = require("../src/modules/purchases/purchases-drafts.service.ts");
const { orderFingerprint } = require("../src/modules/purchases/purchases-fingerprint.ts");
const service = new PurchasesDraftsService();
const originalSecret = process.env.PURCHASE_DRAFT_SECRET;
after(() => { if (originalSecret === undefined) delete process.env.PURCHASE_DRAFT_SECRET; else process.env.PURCHASE_DRAFT_SECRET = originalSecret; });
beforeEach(() => {
  process.env.PURCHASE_DRAFT_SECRET = "test-only-draft-secret-32-characters-long";
  calls.length = 0;
  order = { id, supplierId: id, poCode: "PO-1", status: "ORDERED", orderDate: new Date("2026-10-01"), expectedDeliveryDate: null,
    purchaseOrderItems: [{ id, variantId: id, orderedQty: 10, receivedQty: 0, unitPrice: D(10) }] };
});

test("preview returns signed client-held draft and only reads the database", async () => {
  const result = await service.preview(businessId, "auth", id, { receiptCode: "PR-1", items: [{ poItemId: id, receivedQty: 4, actualCost: "10" }] });
  assert.equal(result.status, "DRAFT"); assert.equal(result.persisted, false); assert.equal(result.totalAmount, "40.00");
  const draft = verifyDraft(result.draftToken, businessId, "auth", id);
  assert.equal(draft.receipt.items[0].actualCost, "10.00");
  assert.equal(draft.orderFingerprint, orderFingerprint(order));
  assert.deepEqual(calls[0], { id, businessId });
});

test("draft rejects signature tampering, wrong user/business/order and expiry", () => {
  const draft = { version: 1, businessId, authUserId: "auth", orderId: id, expiresAt: Date.now() + 3600000, receipt: {}, orderFingerprint: "hash" };
  const token = signDraft(draft);
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url")); payload.receipt.paidAmount = "100";
  const tampered = Buffer.from(JSON.stringify(payload)).toString("base64url") + "." + token.split(".")[1];
  assert.throws(() => verifyDraft(tampered, businessId, "auth", id), (err) => err.statusCode === 400);
  for (const args of [[id, "auth", id], [businessId, "someone-else", id], [businessId, "auth", businessId]]) {
    assert.throws(() => verifyDraft(token, ...args), (err) => err.statusCode === 403);
  }
  assert.throws(() => verifyDraft(token, businessId, "auth", id, draft.expiresAt), (err) => err.statusCode === 409);
  assert.throws(() => verifyDraft("bad", businessId, "auth", id), (err) => err.statusCode === 400);
});

test("draft requires explicit server secret; changing key invalidates old drafts", () => {
  const token = signDraft({ version: 1, businessId, authUserId: "auth", orderId: id, expiresAt: Date.now() + 3600000, receipt: {}, orderFingerprint: "hash" });
  process.env.PURCHASE_DRAFT_SECRET = "another-stable-test-key-with-32-characters";
  assert.throws(() => verifyDraft(token, businessId, "auth", id), (err) => err.statusCode === 400);
  delete process.env.PURCHASE_DRAFT_SECRET;
  assert.throws(() => verifyDraft(token, businessId, "auth", id), (err) => err.statusCode === 503);
});

test("draft rejects over-counted or foreign PO lines", async () => {
  for (const items of [
    [{ poItemId: id, receivedQty: 11, actualCost: "10" }],
    [{ poItemId: businessId, receivedQty: 1, actualCost: "10" }],
  ]) await assert.rejects(service.preview(businessId, "auth", id, { receiptCode: "PR-1", items }), (err) => err.statusCode === 400);
});

test("order fingerprint changes when quantity/price changes, ignores input line order", () => {
  const first = orderFingerprint(order);
  order.purchaseOrderItems[0].receivedQty = 1;
  assert.notEqual(orderFingerprint(order), first);
  order.purchaseOrderItems.push({ ...order.purchaseOrderItems[0], id: businessId });
  const two = orderFingerprint(order);
  order.purchaseOrderItems.reverse();
  assert.equal(orderFingerprint(order), two);
});
