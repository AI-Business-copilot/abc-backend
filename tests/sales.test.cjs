const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
require('ts-node/register/transpile-only');
const { Prisma } = require('@prisma/client');
const D = n => new Prisma.Decimal(n);
const bid = '11111111-1111-4111-8111-111111111111';
const vid = '22222222-2222-4222-8222-222222222222';
const oid = '33333333-3333-4333-8333-333333333333';
const uid = '44444444-4444-4444-8444-444444444444';
const sid = '55555555-5555-4555-8555-555555555555';
let state, failLedger, conflicts, attempts, seen;
const tx = {
  user: { findUnique: async () => ({ id: uid, isActive: true }) },
  cashShift: { findFirst: async ({ where }) => { seen.push(['shift', where]); return state.shift && (!where.id || where.id === state.shift.id) && where.businessId === bid && where.userId === uid ? state.shift : null; } },
  $queryRaw: async () => [{ id: sid }],
  customer: {
    findFirst: async ({ where }) => where.businessId === bid && where.id === state.customer?.id ? state.customer : null,
    findMany: async args => { seen.push(['customers', args]); return state.customer ? [state.customer] : []; },
    count: async ({ where }) => { seen.push(['customerCount', where]); return state.customer ? 1 : 0; },
    create: async ({ data }) => state.customer = { id: oid, ...data },
  },
  productVariant: { findFirst: async ({ where }) => where.businessId === bid && where.id === vid ? state.variant : null },
  inventoryBalance: {
    findMany: async ({ where }) => { seen.push(['stock', where]); return state.balances.filter(b => where.lotItemId === null ? b.lotItemId === null : b.lotItem && b.lotItem.expirationDate >= where.lotItem.is.expirationDate.gte); },
    update: async ({ where, data }) => Object.assign(state.balances.find(b => b.id === where.id), data),
  },
  order: {
    create: async ({ data }) => { const { orderItems, ...rest } = data; return state.order = { id: oid, discountAmount: D(0), ...rest, orderItems: orderItems.create.map((item, i) => ({ id: `line${i}`, lotItemId: null, discountAmount: D(0), ...item })), orderPayments: [] }; },
    findFirst: async ({ where }) => { seen.push(['order', where]); return where.businessId === bid && where.id === oid && state.order ? { ...state.order, orderItems: [...state.order.orderItems], orderPayments: [...state.order.orderPayments] } : null; },
    update: async ({ data }) => Object.assign(state.order, data),
    findMany: async args => { seen.push(['orders', args]); return state.order ? [state.order] : []; },
    count: async ({ where }) => { seen.push(['orderCount', where]); return state.order ? 1 : 0; },
  },
  orderItem: { deleteMany: async () => { state.order.orderItems = []; }, create: async ({ data }) => { state.order.orderItems.push(data); } },
  orderPayment: { create: async ({ data }) => { state.order.orderPayments.push(data); } },
  cashTransaction: { create: async ({ data }) => { state.cashTransactions.push(data); return data; } },
  inventoryLedger: { create: async ({ data }) => { state.ledger.push(data); if (failLedger) throw Error('late failure'); }, findMany: async () => state.ledger },
};
const dbPath = require.resolve('../src/shared/infrastructure/database/prisma.client.ts');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: { ...tx, $transaction: async work => {
  attempts++;
  if (conflicts-- > 0) throw Object.assign(Error('conflict'), { code: 'P2034' });
  // Copy mutable state so a failed transaction restores the fixture.
  const original = state;
  state = { ...state, variant: { ...state.variant }, balances: state.balances.map(b => ({ ...b })), ledger: [...state.ledger], cashTransactions: [...state.cashTransactions], order: state.order ? { ...state.order, orderItems: [...state.order.orderItems], orderPayments: [...state.order.orderPayments] } : null };
  try { return await work(tx); } catch (e) { state = original; throw e; }
} } } };
const { SalesService } = require('../src/modules/sales/sales.service.ts');
const service = new SalesService();
const draft = (extra = {}) => service.create(bid, 'auth', { orderCode: 'POS-1', items: [{ variantId: vid, quantity: 3 }], ...extra });
const pay = (extra = {}, business = bid) => service.complete(business, 'auth', oid, { confirmed: true, paymentMethod: 'CASH', amount: '150', ...extra });
const status = code => e => e.statusCode === code;
beforeEach(() => {
  failLedger = false; conflicts = 0; attempts = 0; seen = [];
  state = { shift: { id: sid }, customer: null, variant: { id: vid, sku: 'SKU', isActive: true, isLockedForAudit: false, basePrice: D(50), costPrice: D(20), template: { hasLotTracking: false } }, balances: [{ id: 'balance', lotItemId: null, quantityOnHand: 10, damagedQuantity: 2, lotItem: null }], ledger: [], cashTransactions: [], order: null };
});

test('draft checks stock and server price, without payment, reservation or stock change', async () => {
  const result = await draft();
  assert.equal(result.status, 'DRAFT'); assert.equal(result.totalNetAmount.toString(), '150');
  assert.equal(result.shiftId, sid); assert.equal(result.cashierId, uid);
  assert.equal(state.balances[0].quantityOnHand, 10); assert.equal(state.ledger.length, 0); assert.equal(result.orderPayments.length, 0);
});
test('payment atomically completes order, links shift, decreases stock and writes negative sale ledger', async () => {
  await draft(); const result = await pay();
  assert.equal(result.status, 'COMPLETED'); assert.equal(result.totalCogsAmount.toString(), '60'); assert.equal(result.grossProfit.toString(), '90');
  assert.equal(state.balances[0].quantityOnHand, 7); assert.equal(state.balances[0].damagedQuantity, 2);
  assert.equal(result.orderPayments[0].shiftId, sid); assert.equal(state.ledger[0].quantityChanged, -3);
  assert.equal(state.ledger[0].totalCostValue.toString(), '-60'); assert.equal(state.ledger[0].transactionType, 'POS_SALE');
  assert.equal(state.cashTransactions.length, 1); assert.equal(state.cashTransactions[0].transactionType, 'IN');
  assert.equal(state.cashTransactions[0].amount.toString(), '150'); assert.equal(state.cashTransactions[0].refDocId, oid);
  await assert.rejects(pay(), status(409)); assert.equal(state.ledger.length, 1); assert.equal(state.order.orderPayments.length, 1);
});
test('FEFO skips expired and damaged stock, splits lots, and reallocates at payment', async () => {
  state.variant.template.hasLotTracking = true;
  const lot = (id, expires, qty, damaged = 0) => ({ id, lotItemId: id, lotItem: { expirationDate: new Date(expires) }, quantityOnHand: qty, damagedQuantity: damaged });
  state.balances = [lot('late', '2099-12-01', 5), lot('expired', '2000-01-01', 99), lot('early', '2099-01-01', 3, 1)];
  await draft();
  state.balances[2].quantityOnHand = 2;
  const result = await pay({ paymentMethod: 'BANK_TRANSFER', paymentReference: 'BANK-1' });
  assert.deepEqual(result.orderItems.map(l => [l.lotItemId, l.quantity]), [['early', 1], ['late', 2]]);
  assert.equal(state.balances[1].quantityOnHand, 99);
  assert.equal(result.orderPayments[0].paymentMethod, 'BANK_TRANSFER');
  assert.equal(state.cashTransactions.length, 0);
});
test('stock changed after draft blocks payment and rolls back draft lines', async () => {
  await draft(); state.balances[0].quantityOnHand = 4;
  await assert.rejects(pay(), status(409));
  assert.equal(state.order.status, 'DRAFT'); assert.equal(state.order.orderItems.length, 1); assert.equal(state.order.orderPayments.length, 0);
  assert.equal(state.balances[0].quantityOnHand, 4); assert.equal(state.ledger.length, 0);
});
test('late write failure rolls back stock, lines, ledger, payment and order', async () => {
  await draft(); failLedger = true;
  await assert.rejects(pay(), /late failure/);
  assert.equal(state.order.status, 'DRAFT'); assert.equal(state.balances[0].quantityOnHand, 10);
  assert.equal(state.ledger.length, 0); assert.equal(state.order.orderPayments.length, 0); assert.equal(state.order.orderItems[0].quantity, 3);
});
test('invalid quantity, duplicate SKU, missing shift, audit lock and foreign customer are blocked', async () => {
  await assert.rejects(draft({ items: [{ variantId: vid, quantity: 0 }] }), status(400));
  await assert.rejects(draft({ items: [{ variantId: vid, quantity: 1 }, { variantId: vid, quantity: 1 }] }), status(400));
  await assert.rejects(draft({ customerId: oid }), status(404));
  state.variant.isLockedForAudit = true; await assert.rejects(draft(), status(409)); state.variant.isLockedForAudit = false;
  state.shift = null; await assert.rejects(draft(), status(409));
});
test('payment validates confirmation, exact total, method, scope, cashier and original open shift', async () => {
  await draft();
  for (const extra of [{ confirmed: false }, { amount: '149' }, { amount: '151' }, { amount: '0' }, { paymentMethod: 'VIETQR' }]) await assert.rejects(pay(extra), status(400));
  await assert.rejects(pay({}, oid), status(404));
  state.order.cashierId = oid; await assert.rejects(pay(), status(403)); state.order.cashierId = uid;
  state.shift = null; await assert.rejects(pay(), status(409));
  assert.equal(state.ledger.length, 0); assert.equal(state.order.status, 'DRAFT');
});
test('cancel is repeatable and does not alter stock; completed orders cannot be cancelled', async () => {
  await draft(); await service.cancel(bid, 'auth', oid); await service.cancel(bid, 'auth', oid);
  assert.equal(state.order.status, 'CANCELLED'); assert.equal(state.balances[0].quantityOnHand, 10); await assert.rejects(pay(), status(409));
});
test('serializable retry commits once and reports persistent conflicts as 409', async () => {
  await draft(); conflicts = 2; attempts = 0; await pay(); assert.equal(attempts, 3); assert.equal(state.ledger.length, 1);
  conflicts = 3; attempts = 0; await assert.rejects(pay(), status(409)); assert.equal(attempts, 3); assert.equal(state.ledger.length, 1);
});
test('completed order cannot be cancelled, and failed cancellation leaves payment and stock intact', async () => {
  await draft(); await pay(); await assert.rejects(service.cancel(bid, 'auth', oid), status(409));
  assert.equal(state.order.status, 'COMPLETED'); assert.equal(state.order.orderPayments.length, 1); assert.equal(state.balances[0].quantityOnHand, 7);
});
test('customer is optional, scoped, validated, and can be attached to a draft', async () => {
  await assert.rejects(service.createCustomer(bid, { name: '', phone: '123' }), status(400));
  const customer = await service.createCustomer(bid, { name: 'Khach F04', phone: '123' });
  assert.equal(customer.businessId, bid);
  const result = await draft({ customerId: customer.id }); assert.equal(result.customerId, customer.id);
});
test('list rows and counts share business scope, paging and date/status filters', async () => {
  await draft();
  const result = await service.list(bid, { status: 'DRAFT', from: '2026-11-01', to: '2026-11-02', search: 'POS', page: '2', pageSize: '5' });
  assert.equal(result.pagination.total, 1); assert.equal(result.pagination.page, 2);
  const args = seen.find(([name]) => name === 'orders')[1];
  assert.equal(args.where.businessId, bid); assert.equal(args.where.status, 'DRAFT'); assert.equal(args.skip, 5);
  assert.equal(args.where.createdAt.lt.toISOString(), '2026-11-03T00:00:00.000Z');
  assert.deepEqual(seen.find(([name]) => name === 'orderCount')[1], args.where);
  await service.list(bid, { search: '123' }, true);
  assert.equal(seen.find(([name]) => name === 'customers')[1].where.businessId, bid);
  for (const query of [{ pageSize: '101' }, { status: 'BAD' }, { from: '2026-11-03', to: '2026-11-02' }]) await assert.rejects(service.list(bid, query), status(400));
});
test('get scopes order before loading its ledger; foreign order is hidden', async () => {
  await draft(); await pay();
  const result = await service.get(bid, oid); assert.equal(result.inventoryLedger.length, 1);
  await assert.rejects(service.get(oid, oid), status(404));
});
test('FEFO allows expiration today in Vietnam', async () => {
  const today = new Date(new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10));
  state.variant.template.hasLotTracking = true;
  state.balances = [{ id: 'today', lotItemId: 'today', lotItem: { expirationDate: today }, quantityOnHand: 3, damagedQuantity: 0 }];
  await draft(); await pay(); assert.equal(state.balances[0].quantityOnHand, 0);
  assert.ok(state.balances[0].outOfStockSince instanceof Date);
});
