require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requirePermission } = require('../src/shared/auth/require-permission.middleware');
let access;
let profileCalls;
const profilePath = require.resolve('../src/shared/auth/user-profile.service');
const accessPath = require.resolve('../src/shared/auth/access-context.service');
require.cache[profilePath] = { id: profilePath, filename: profilePath, loaded: true, exports: {
  ensureUserProfile: async () => { profileCalls++; return { id: 'user' }; },
} };
require.cache[accessPath] = { id: accessPath, filename: accessPath, loaded: true, exports: {
  getAccessContext: async () => access,
} };
const { requireBusinessScope } = require('../src/shared/auth/business-scope.middleware');
const validAccess = () => ({ membership: { businessId: 'shop', status: 'ACTIVE', business: { status: 'ACTIVE' }, role: { code: 'STAFF' } }, permissionCodes: ['sales.create'] });
async function invoke(overrides = {}) {
  const req = { identity: { id: 'auth' }, query: {}, header: () => undefined, ...overrides };
  const res = { locals: {} };
  const calls = [];
  await requireBusinessScope(req, res, error => calls.push(error));
  assert.equal(calls.length, 1);
  return { error: calls[0], locals: res.locals };
}

test('permission middleware denies missing or unrelated permissions', () => {
  for (const locals of [{}, { permissionCodes: [] }, { permissionCodes: ['sales.read'] }]) {
    const calls = [];
    requirePermission('sales.create')({}, { locals }, error => calls.push(error));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].statusCode, 403);
  }
});
test('permission middleware allows only the requested permission', () => {
  const calls = [];
  requirePermission('sales.create')({}, { locals: { permissionCodes: ['sales.create'] } }, error => calls.push(error));
  assert.deepEqual(calls, [undefined]);
});
test('business scope rejects unauthenticated requests before loading a profile', async () => {
  profileCalls = 0;
  assert.equal((await invoke({ identity: undefined })).error.statusCode, 401);
  assert.equal(profileCalls, 0);
});
test('business scope rejects missing, inactive or suspended memberships', async () => {
  for (const membership of [null, { ...validAccess().membership, status: 'INACTIVE' }, { ...validAccess().membership, business: { status: 'SUSPENDED' } }]) {
    access = { ...validAccess(), membership };
    const result = await invoke();
    assert.equal(result.error.statusCode, 403);
    assert.equal(result.locals.businessId, undefined);
  }
});
test('business scope rejects foreign business IDs in the body or query', async () => {
  access = validAccess();
  for (const request of [{ body: { businessId: 'foreign' } }, { query: { businessId: 'foreign' } }]) {
    assert.equal((await invoke(request)).error.statusCode, 403);
  }
});
test('business scope sets server-derived identity, business and permissions', async () => {
  access = validAccess();
  for (const request of [{}, { body: { businessId: ' shop ' } }, { query: { businessId: 'shop' } }]) {
    const result = await invoke(request);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.locals, { userId: 'user', businessId: 'shop', businessRole: 'STAFF', permissionCodes: ['sales.create'] });
  }
});
