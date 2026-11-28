require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = {
  productLotItem: { findMany: async () => [] },
  scrapOrder: { findMany: async () => [] },
  stockAuditItem: { findMany: async () => [] },
  notificationRead: { findMany: async () => [], createMany: async () => {} },
};
const databasePath = require.resolve('../src/shared/infrastructure/database/prisma.client');
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma } };
const { activeNotifications, listNotifications, markNotificationsRead } = require('../src/modules/notifications/notifications.service');
const scope = { businessId: 'store-a', userId: 'member-a', permissions: ['inventory.read', 'inventory.lot.read', 'inventory.scrap.approve', 'inventory.audit.count'] };

function stub(t, model, method, implementation) { t.mock.method(prisma[model], method, implementation); }
function emptySources(t) {
  stub(t, 'productLotItem', 'findMany', async () => []);
  stub(t, 'scrapOrder', 'findMany', async () => []);
  stub(t, 'stockAuditItem', 'findMany', async () => []);
}

test('no permissions means no source data is queried or leaked', async t => {
  for (const model of ['productLotItem', 'scrapOrder', 'stockAuditItem']) {
    stub(t, model, 'findMany', () => { throw Error('must not query'); });
  }
  assert.deepEqual(await activeNotifications({ ...scope, permissions: [] }), []);
});

test('sources are restricted to the store, current assignee and active workflow', async t => {
  stub(t, 'productLotItem', 'findMany', async query => {
    assert.equal(query.where.businessId, 'store-a');
    assert.deepEqual(query.where.status.in, ['HEALTHY', 'WARNING', 'UNUSABLE']);
    assert.deepEqual(query.where.inventoryBalances.some, { businessId: 'store-a', quantityOnHand: { gt: 0 } });
    assert.equal(query.where.expirationDate.lte.toISOString(), '2027-01-16T00:00:00.000Z');
    return [{ id: 'lot-a', expirationDate: new Date('2026-11-20'), lot: { lotNumber: 'L01' }, variant: { sku: 'SKU1', template: { name: 'Sữa' } } }];
  });
  stub(t, 'scrapOrder', 'findMany', async query => {
    assert.deepEqual(query.where, { businessId: 'store-a', status: 'PENDING' });
    return [{ id: 'scrap-a', scrapCode: 'H01', scrapQty: 2, createdAt: new Date('2026-11-17') }];
  });
  stub(t, 'stockAuditItem', 'findMany', async query => {
    assert.deepEqual(query.where, { assignedToUserId: 'member-a', itemStatus: 'IN_PROGRESS', audit: { businessId: 'store-a', status: 'IN_PROGRESS' } });
    return [{ id: 'task-a', auditId: 'audit-a', rejectedAt: null, audit: { countStartAt: new Date('2026-11-16') }, variant: { sku: 'SKU1' } }];
  });
  const items = await activeNotifications(scope, new Date('2026-11-16T18:00:00Z'));
  assert.equal(items.length, 3);
  assert.match(items.find(x => x.type === 'LOT_EXPIRY').message, /còn 3 ngày/);
  assert.equal(items.find(x => x.type === 'AUDIT_ASSIGNED').href, '/inventory/audit/audit-a/items/task-a');
});

test('fails explicitly when an in-progress audit task has no timestamp', async t => {
  emptySources(t);
  stub(t, 'stockAuditItem', 'findMany', async () => [{
    id: 'task-a', auditId: 'audit-a', rejectedAt: null, audit: { countStartAt: null }, variant: { sku: 'SKU1' },
  }]);
  await assert.rejects(
    activeNotifications(scope),
    { message: 'In-progress stock audit task task-a has no count start time.' },
  );
});

test('expiry escalation creates a new unread identity at warning, unusable and expired stages', async t => {
  emptySources(t);
  prisma.productLotItem.findMany.mock.mockImplementation(async () => [{ id: 'lot', expirationDate: new Date('2026-12-01'), lot: { lotNumber: 'L' }, variant: { sku: 'S', template: { name: 'P' } } }]);
  const id = async day => (await activeNotifications(scope, new Date(day)))[0].id;
  assert.match(await id('2026-11-01T00:00:00Z'), /:warning$/);
  assert.match(await id('2026-11-24T00:00:00Z'), /:unusable$/);
  assert.match(await id('2026-12-02T00:00:00Z'), /:expired$/);
});

test('pagination counts all unread items, reads are isolated per user and store', async t => {
  emptySources(t);
  prisma.scrapOrder.findMany.mock.mockImplementation(async () => Array.from({ length: 25 }, (_, i) => ({ id: String(i), scrapCode: `H${i}`, scrapQty: 1, createdAt: new Date('2026-11-17') })));
  stub(t, 'notificationRead', 'findMany', async query => {
    assert.deepEqual(query.where, { businessId: 'store-a', userId: 'member-a' });
    return [{ notificationId: 'scrap:0', readAt: new Date('2026-11-17') }];
  });
  const result = await listNotifications(scope, 2);
  assert.equal(result.total, 25);
  assert.equal(result.unreadCount, 24);
  assert.equal(result.items.length, 5);
  assert.equal(result.items.at(-1).id, 'scrap:0');
  assert.ok(result.items.at(-1).readAt);
});

test('mark read rejects forged/unauthorized or resolved IDs and validates input before writing', async t => {
  emptySources(t);
  stub(t, 'notificationRead', 'createMany', () => { throw Error('must not write'); });
  for (const invalid of [null, [], 'all', [12], Array(101).fill('a')]) {
    await assert.rejects(() => markNotificationsRead(scope, invalid), { statusCode: 400 });
  }
  await assert.rejects(() => markNotificationsRead(scope, ['scrap:another-store']), { statusCode: 404 });
});

test('read writes are idempotent and store separate receipts for each member', async t => {
  emptySources(t);
  prisma.scrapOrder.findMany.mock.mockImplementation(async () => [{ id: 'a', scrapCode: 'H1', scrapQty: 1, createdAt: null }]);
  stub(t, 'notificationRead', 'createMany', async query => {
    assert.equal(query.skipDuplicates, true);
    assert.deepEqual(query.data, [{ businessId: 'store-a', userId: 'member-a', notificationId: 'scrap:a' }]);
  });
  await markNotificationsRead(scope, ['scrap:a', 'scrap:a']);
});
