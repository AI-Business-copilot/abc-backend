// Read-only smoke check against the configured database. Never creates demo alerts.
require('ts-node/register/transpile-only');
const { prisma } = require('../src/shared/infrastructure/database/prisma.client');
const { listNotifications } = require('../src/modules/notifications/notifications.service');
(async () => {
  const membership = await prisma.businessMembership.findFirst({
    where: { status: 'ACTIVE', business: { status: 'ACTIVE' }, user: { status: 'ACTIVE' } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  if (!membership) throw new Error('No active membership available for the read-only smoke check.');
  const result = await listNotifications({
    businessId: membership.businessId,
    userId: membership.userId,
    permissions: membership.role.permissions.map(row => row.permission.code),
  });
  if (result.unreadCount > result.total || result.items.length > result.pageSize) throw new Error('Invalid notification response.');
  console.log(JSON.stringify({ ok: true, total: result.total, unreadCount: result.unreadCount, returned: result.items.length }));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
