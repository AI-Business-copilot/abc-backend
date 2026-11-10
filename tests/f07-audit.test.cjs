const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");

const BUSINESS = "22222222-2222-4222-8222-222222222222";
const OWNER = "11111111-1111-4111-8111-111111111111";
const STAFF = "77777777-7777-4777-8777-777777777777";
const AUDIT = "44444444-4444-4444-8444-444444444444";
const ITEM = "55555555-5555-4555-8555-555555555555";
const ITEM_2 = "55555555-5555-4555-8555-555555555556";
const VARIANT = "33333333-3333-4333-8333-333333333333";
const VARIANT_2 = "33333333-3333-4333-8333-333333333334";
const LOT_ITEM = "66666666-6666-4666-8666-666666666666";

/** A full AUDIT_ITEM_SELECT row so formatAuditItem can run on mocked reads. */
const itemRow = (overrides = {}) => ({
  id: ITEM,
  variantId: VARIANT,
  lotItemId: null,
  lotNumber: "LOT-1",
  lotMode: "NEW",
  newLotExpirationDate: new Date("2027-01-01T00:00:00Z"),
  newLotManufacturingDate: null,
  auditId: AUDIT,
  snapshotQty: 0,
  countedQty: 5,
  diffQty: 5,
  discrepancyReason: "Kiểm kê",
  itemStatus: "IN_PROGRESS",
  assignedToUserId: STAFF,
  submittedAt: null,
  submittedBy: null,
  approvedAt: null,
  approvedBy: null,
  rejectionReason: null,
  rejectedAt: null,
  rejectedBy: null,
  createdBy: OWNER,
  variant: {
    sku: "SKU-1",
    template: { name: "Sneaker", imageUrl: null },
    variantAttributeValues: [{ attributeValue: { value: "L" } }],
  },
  lotItem: null,
  assignedToUser: { id: STAFF, fullName: "Nhân viên", email: "staff@example.com" },
  createdByUser: { id: OWNER, fullName: "Chủ cửa hàng", email: "owner@example.com" },
  submittedByUser: null,
  approvedByUser: null,
  rejectedByUser: null,
  ...overrides,
});

let state;
let calls;

const resetState = () => {
  calls = [];
  state = {
    user: { id: OWNER, status: "ACTIVE", fullName: "Chủ cửa hàng", email: "owner@example.com" },
    audit: { id: AUDIT, auditCode: "AUDIT_2026_0001", status: "IN_PROGRESS", auditType: "RE_AUDIT" },
    auditWithCode: null,
    lastAudit: null,
    createdAudit: {
      id: AUDIT,
      auditCode: "AUDIT_2026_0001",
      scopeType: "ALL",
      auditType: "RE_AUDIT",
      status: "IN_PROGRESS",
      isLockedForAudit: true,
      countStartAt: new Date("2026-11-10T00:00:00Z"),
    },
    appliedAudit: { id: AUDIT, auditCode: "AUDIT_2026_0001", status: "DONE", auditType: "RE_AUDIT" },
    item: { id: ITEM, itemStatus: "IN_PROGRESS", auditId: AUDIT, assignedToUserId: OWNER, lotItemId: null },
    items: [],
    remaining: 1,
    updatedItem: { id: ITEM, itemStatus: "APPROVED", approvedAt: new Date(), approvedBy: OWNER },
    formattedRow: itemRow(),
    variants: [{ id: VARIANT }],
    lotItems: [{ id: LOT_ITEM, variantId: VARIANT }],
    lotRows: [{ id: LOT_ITEM, lot: { lotNumber: "LOT-1" } }],
    lotItemRow: null,
    existingLot: null,
    duplicateLotItem: null,
    sameNewLot: null,
    balance: { id: "balance-1", quantityOnHand: 7 },
    balanceAgg: { _sum: { quantityOnHand: 12 } },
    membership: null,
    staffMemberships: [{ userId: STAFF }],
    upsertedLot: { id: "lot-1" },
    createdLotItem: { id: "new-lot-item" },
  };
};

const db = {
  user: {
    findUnique: async (args) => {
      calls.push(["userFindUnique", args]);
      return state.user;
    },
  },
  businessMembership: {
    findFirst: async (args) => {
      calls.push(["membershipFindFirst", args]);
      return state.membership;
    },
    findMany: async (args) => {
      calls.push(["membershipFindMany", args]);
      return state.staffMemberships;
    },
  },
  stockAudit: {
    findFirst: async (args) => {
      calls.push(["auditFindFirst", args]);
      const code = args?.where?.auditCode;
      if (typeof code === "string") return state.auditWithCode;
      if (code && typeof code === "object") return state.lastAudit;
      return state.audit;
    },
    create: async (args) => {
      calls.push(["auditCreate", args]);
      return state.createdAudit;
    },
    update: async (args) => {
      calls.push(["auditUpdate", args]);
      return state.appliedAudit;
    },
  },
  stockAuditItem: {
    findFirst: async (args) => {
      calls.push(["itemFindFirst", args]);
      const where = args?.where ?? {};
      if (where.lotNumber !== undefined) return state.sameNewLot;
      if (where.variantId !== undefined && where.lotItemId !== undefined) return state.duplicateLotItem;
      return state.item;
    },
    findUnique: async (args) => {
      calls.push(["itemFindUnique", args]);
      return state.formattedRow;
    },
    findMany: async (args) => {
      calls.push(["itemFindMany", args]);
      return state.items;
    },
    count: async (args) => {
      calls.push(["itemCount", args]);
      return state.remaining;
    },
    update: async (args) => {
      calls.push(["itemUpdate", args]);
      return state.updatedItem;
    },
    createMany: async (args) => {
      calls.push(["itemCreateMany", args]);
    },
  },
  productVariant: {
    findMany: async (args) => {
      calls.push(["variantFindMany", args]);
      return state.variants;
    },
    updateMany: async (args) => {
      calls.push(["variantUpdateMany", args]);
    },
  },
  productLotItem: {
    findMany: async (args) => {
      calls.push(["lotItemFindMany", args]);
      return args?.select?.lot ? state.lotRows : state.lotItems;
    },
    findFirst: async (args) => {
      calls.push(["lotItemFindFirst", args]);
      return state.lotItemRow;
    },
    create: async (args) => {
      calls.push(["lotItemCreate", args]);
      return state.createdLotItem;
    },
    update: async (args) => {
      calls.push(["lotItemUpdate", args]);
    },
    updateMany: async (args) => {
      calls.push(["lotItemUpdateMany", args]);
    },
  },
  productLot: {
    findFirst: async (args) => {
      calls.push(["lotFindFirst", args]);
      return state.existingLot;
    },
    upsert: async (args) => {
      calls.push(["lotUpsert", args]);
      return state.upsertedLot;
    },
  },
  inventoryBalance: {
    findFirst: async (args) => {
      calls.push(["balanceFindFirst", args]);
      return state.balance;
    },
    create: async (args) => {
      calls.push(["balanceCreate", args]);
    },
    update: async (args) => {
      calls.push(["balanceUpdate", args]);
    },
    aggregate: async (args) => {
      calls.push(["balanceAggregate", args]);
      return state.balanceAgg;
    },
  },
  inventoryLedger: {
    createMany: async (args) => {
      calls.push(["ledgerCreateMany", args]);
    },
  },
  $transaction: async (work) => work(db),
};

const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { prisma: db },
};

const { auditService } = require("../src/modules/inventory/services/audit.service.ts");

beforeEach(resetState);

const wrote = (name) => calls.some(([key]) => key === name);
const call = (name) => calls.find(([key]) => key === name);
const rejects = (fn, statusCode) =>
  assert.rejects(fn, (err) => {
    assert.equal(err.statusCode, statusCode, `expected ${statusCode}, got ${err.statusCode}: ${err.message}`);
    return true;
  });

test("audit creation rejects an unknown type, a duplicate code and invalid rows", async () => {
  await rejects(() => auditService.createAudit(BUSINESS, "auth", { auditType: "BOGUS" }), 400);

  state.auditWithCode = { id: AUDIT };
  await rejects(
    () => auditService.createAudit(BUSINESS, "auth", { auditType: "RE_AUDIT", auditCode: "AUDIT_2026_0001" }),
    409,
  );
  state.auditWithCode = null;

  await rejects(
    () => auditService.createAudit(BUSINESS, "auth", { auditType: "NEW_LOTS", items: [{ variantId: VARIANT }] }),
    400,
  );
  await rejects(
    () => auditService.createAudit(BUSINESS, "auth", { auditType: "NEW_LOTS", items: [{ assignedToUserId: STAFF }] }),
    400,
  );
  await rejects(
    () =>
      auditService.createAudit(BUSINESS, "auth", {
        auditType: "NEW_LOTS",
        items: [{ assignedToUserId: STAFF, variantId: VARIANT, lotItemId: LOT_ITEM }],
      }),
    400,
  );
  await rejects(
    () =>
      auditService.createAudit(BUSINESS, "auth", {
        auditType: "RE_AUDIT",
        items: [{ assignedToUserId: STAFF, variantId: VARIANT }],
      }),
    400,
  );

  state.staffMemberships = [];
  await rejects(
    () =>
      auditService.createAudit(BUSINESS, "auth", {
        auditType: "RE_AUDIT",
        items: [{ assignedToUserId: STAFF, variantId: VARIANT, lotItemId: LOT_ITEM }],
      }),
    400,
  );

  state.staffMemberships = [{ userId: STAFF }];
  const row = { assignedToUserId: STAFF, variantId: VARIANT, lotItemId: LOT_ITEM };
  await rejects(
    () => auditService.createAudit(BUSINESS, "auth", { auditType: "RE_AUDIT", items: [row, { ...row }] }),
    409,
  );

  assert.equal(wrote("auditCreate"), false, "no audit may be created when validation fails");
});

test("audit creation locks the variants and snapshots the current balance", async () => {
  const created = await auditService.createAudit(BUSINESS, "auth", {
    auditType: "RE_AUDIT",
    items: [{ assignedToUserId: STAFF, variantId: VARIANT, lotItemId: LOT_ITEM }],
  });

  assert.equal(created.auditCode, "AUDIT_2026_0001");
  assert.equal(created.itemCount, 1);
  assert.equal(created.affectedVariantCount, 1);

  const lock = call("variantUpdateMany")[1];
  assert.deepEqual(lock.where, { id: { in: [VARIANT] } });
  assert.equal(lock.data.isLockedForAudit, true);

  const lotLock = call("lotItemUpdateMany")[1];
  assert.deepEqual(lotLock.data, { isLockedForAudit: true });

  const item = call("itemCreateMany")[1].data[0];
  assert.equal(item.snapshotQty, 7);
  assert.equal(item.lotNumber, "LOT-1");
  assert.equal(item.lotMode, "EXISTING");
  assert.equal(item.itemStatus, "IN_PROGRESS");
  assert.equal(item.countedQty, 0);
});

test("reassignment only moves an in-progress row to an active non-owner member", async () => {
  await rejects(() => auditService.reassignAuditItem(BUSINESS, AUDIT, ITEM, {}), 400);

  state.audit = null;
  await rejects(() => auditService.reassignAuditItem(BUSINESS, AUDIT, ITEM, { assignedToUserId: STAFF }), 404);

  state.audit = { id: AUDIT, status: "DONE" };
  await rejects(() => auditService.reassignAuditItem(BUSINESS, AUDIT, ITEM, { assignedToUserId: STAFF }), 409);

  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = null;
  await rejects(() => auditService.reassignAuditItem(BUSINESS, AUDIT, ITEM, { assignedToUserId: STAFF }), 404);

  state.item = { id: ITEM, itemStatus: "PENDING_APPROVAL" };
  await rejects(() => auditService.reassignAuditItem(BUSINESS, AUDIT, ITEM, { assignedToUserId: STAFF }), 409);

  state.item = { id: ITEM, itemStatus: "IN_PROGRESS" };
  state.staffMemberships = [];
  await rejects(() => auditService.reassignAuditItem(BUSINESS, AUDIT, ITEM, { assignedToUserId: OWNER }), 400);

  state.staffMemberships = [{ userId: STAFF }];
  const result = await auditService.reassignAuditItem(BUSINESS, AUDIT, ITEM, { assignedToUserId: STAFF });

  assert.equal(call("itemUpdate")[1].data.assignedToUserId, STAFF);
  assert.equal(result.id, ITEM);
});

test("a count needs a non-negative quantity, an in-progress row and a discrepancy reason", async () => {
  await rejects(
    () => auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, { countedQty: -1, discrepancyReason: "x" }),
    400,
  );

  state.audit = { id: AUDIT, status: "DONE", auditType: "RE_AUDIT" };
  await rejects(
    () => auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, { countedQty: 1, discrepancyReason: "x" }),
    409,
  );

  state.audit = { id: AUDIT, status: "IN_PROGRESS", auditType: "RE_AUDIT" };
  state.item = { id: ITEM, itemStatus: "PENDING_APPROVAL", assignedToUserId: OWNER, lotItemId: LOT_ITEM, variantId: VARIANT };
  await rejects(
    () => auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, { countedQty: 1, discrepancyReason: "x" }),
    409,
  );

  state.item = { id: ITEM, itemStatus: "IN_PROGRESS", assignedToUserId: OWNER, lotItemId: LOT_ITEM, variantId: VARIANT };
  await rejects(() => auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, { countedQty: 3 }), 400);

  const saved = await auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
    countedQty: 3,
    discrepancyReason: "Hàng rơi",
  });
  assert.equal(call("itemUpdate")[1].data.countedQty, 3);
  assert.equal(call("itemUpdate")[1].data.discrepancyReason, "Hàng rơi");
  assert.equal(saved.id, ITEM);
});

test("counting a new lot rejects impossible dates and duplicate lot numbers", async () => {
  const base = { countedQty: 2, discrepancyReason: "x" };

  state.audit = { id: AUDIT, status: "IN_PROGRESS", auditType: "NEW_LOTS" };
  state.item = { id: ITEM, itemStatus: "IN_PROGRESS", assignedToUserId: OWNER, lotItemId: null, variantId: VARIANT };

  await rejects(
    () => auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, { ...base, lotItemId: LOT_ITEM, newLotNumber: "N1" }),
    400,
  );
  await rejects(() => auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, { ...base, newLotNumber: "N1" }), 400);
  await rejects(
    () =>
      auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
        ...base,
        newLotNumber: "N1",
        newLotExpirationDate: "2026-12-01",
        newLotManufacturingDate: "2027-01-01",
      }),
    400,
  );

  state.existingLot = { id: "lot-9", items: [{ id: ITEM }] };
  await rejects(
    () =>
      auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
        ...base,
        newLotNumber: "N1",
        newLotExpirationDate: "2027-12-01",
      }),
    409,
  );

  state.existingLot = null;
  state.sameNewLot = { id: ITEM_2 };
  await rejects(
    () =>
      auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
        ...base,
        newLotNumber: "N1",
        newLotExpirationDate: "2027-12-01",
      }),
    409,
  );

  state.sameNewLot = null;
  const saved = await auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
    ...base,
    newLotNumber: "N2",
    newLotExpirationDate: "2027-12-01",
  });
  const data = call("itemUpdate")[1].data;
  assert.equal(data.lotMode, "NEW");
  assert.equal(data.lotNumber, "N2");
  assert.equal(data.snapshotQty, 0);
  assert.equal(data.countedQty, 2);
  assert.equal(saved.id, ITEM);
});

test("an existing lot row stores only the dates the employee corrected", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS", auditType: "RE_AUDIT" };
  state.item = {
    id: ITEM,
    itemStatus: "IN_PROGRESS",
    assignedToUserId: OWNER,
    lotItemId: LOT_ITEM,
    variantId: VARIANT,
    snapshotQty: 7,
  };
  state.lotItemRow = {
    id: LOT_ITEM,
    expirationDate: new Date("2027-01-01T00:00:00Z"),
    manufacturingDate: null,
    lot: { lotNumber: "LOT-1" },
  };

  await auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
    countedQty: 4,
    discrepancyReason: "Sai hạn",
    newLotExpirationDate: "2027-02-01",
  });

  const data = call("itemUpdate")[1].data;
  assert.equal(data.snapshotQty, 7);
  assert.equal(data.newLotExpirationDate.toISOString().slice(0, 10), "2027-02-01");
  assert.equal(data.newLotManufacturingDate, null);
  assert.equal("lotItemId" in data, false, "a date correction does not re-point the row at another lot");
});

test("submission requires a lot, an expiry for a new lot and a reason, then clears the rejection", async () => {
  const submitted = {
    id: ITEM,
    itemStatus: "IN_PROGRESS",
    auditId: AUDIT,
    variantId: VARIANT,
    lotItemId: null,
    lotNumber: null,
    newLotExpirationDate: null,
    discrepancyReason: "x",
    assignedToUserId: OWNER,
  };
  state.item = submitted;
  await rejects(() => auditService.submitAuditItem(BUSINESS, "auth", AUDIT, ITEM, {}), 400);

  state.item = { ...submitted, lotNumber: "N1" };
  await rejects(() => auditService.submitAuditItem(BUSINESS, "auth", AUDIT, ITEM, {}), 400);

  state.item = { ...submitted, lotNumber: "N1", newLotExpirationDate: new Date("2027-01-01"), discrepancyReason: null };
  await rejects(() => auditService.submitAuditItem(BUSINESS, "auth", AUDIT, ITEM, {}), 400);

  state.item = { ...state.item, discrepancyReason: "x", itemStatus: "APPROVED" };
  await rejects(() => auditService.submitAuditItem(BUSINESS, "auth", AUDIT, ITEM, {}), 409);

  state.item = { ...state.item, itemStatus: "IN_PROGRESS" };
  state.formattedRow = itemRow({ itemStatus: "PENDING_APPROVAL", rejectionReason: null });
  const result = await auditService.submitAuditItem(BUSINESS, "auth", AUDIT, ITEM, {});

  const data = call("itemUpdate")[1].data;
  assert.equal(data.itemStatus, "PENDING_APPROVAL");
  assert.equal(data.rejectionReason, null);
  assert.equal(data.rejectedAt, null);
  assert.equal(data.rejectedBy, null);
  assert.equal(data.submittedBy, OWNER);
  assert.equal(result.itemStatus, "PENDING_APPROVAL");
});

test("rejection wants a reason of at most 1000 characters and only accepts a submitted row", async () => {
  await rejects(() => auditService.rejectAuditItem(BUSINESS, "auth", AUDIT, ITEM, { reason: "  " }), 400);
  await rejects(() => auditService.rejectAuditItem(BUSINESS, "auth", AUDIT, ITEM, { reason: "x".repeat(1001) }), 400);

  state.item = { id: ITEM, itemStatus: "IN_PROGRESS" };
  await rejects(() => auditService.rejectAuditItem(BUSINESS, "auth", AUDIT, ITEM, { reason: "Sai số" }), 409);

  state.item = { id: ITEM, itemStatus: "PENDING_APPROVAL" };
  state.formattedRow = itemRow({ itemStatus: "IN_PROGRESS", rejectionReason: "Sai số" });
  const result = await auditService.rejectAuditItem(BUSINESS, "auth", AUDIT, ITEM, { reason: "Sai số" });

  const data = call("itemUpdate")[1].data;
  assert.equal(data.itemStatus, "IN_PROGRESS");
  assert.equal(data.rejectionReason, "Sai số");
  assert.equal(data.submittedAt, null);
  assert.equal(data.submittedBy, null);
  assert.equal(result.rejectionReason, "Sai số");
});

test("approving the last pending row applies the audit automatically", async () => {
  state.item = { id: ITEM, itemStatus: "APPROVED" };
  await rejects(() => auditService.approveAuditItem(BUSINESS, "auth", AUDIT, ITEM), 409);

  state.item = { id: ITEM, itemStatus: "PENDING_APPROVAL", variantId: VARIANT };
  state.remaining = 2;
  const partial = await auditService.approveAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(partial.auditAutoApplied, false);
  assert.equal(wrote("auditUpdate"), false, "a partially approved audit must not be applied");

  state.remaining = 0;
  state.audit = {
    id: AUDIT,
    auditCode: "AUDIT_2026_0001",
    status: "IN_PROGRESS",
    auditType: "RE_AUDIT",
    stockAuditItems: [
      {
        id: ITEM,
        variantId: VARIANT,
        lotItemId: LOT_ITEM,
        lotNumber: "LOT-1",
        snapshotQty: 5,
        countedQty: 5,
        variant: { costPrice: 1 },
        lotItem: null,
      },
    ],
  };
  const applied = await auditService.approveAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(applied.auditAutoApplied, true);
  assert.equal(call("auditUpdate")[1].data.status, "DONE");
});

test("applying an audit sets balances and writes a ledger row only when the count differs", async () => {
  state.audit = { id: AUDIT, auditCode: "AUDIT_2026_0001", status: "DONE", auditType: "RE_AUDIT", stockAuditItems: [] };
  const done = await auditService.applyAudit(BUSINESS, "auth", AUDIT);
  assert.equal(done.status, "DONE");
  assert.equal(wrote("auditUpdate"), false, "an applied audit is not applied twice");

  state.audit = { id: AUDIT, auditCode: "AUDIT_2026_0001", status: "IN_PROGRESS", auditType: null, stockAuditItems: [] };
  await rejects(() => auditService.applyAudit(BUSINESS, "auth", AUDIT), 400);

  state.audit = { id: AUDIT, auditCode: "AUDIT_2026_0001", status: "IN_PROGRESS", auditType: "RE_AUDIT", stockAuditItems: [] };
  await rejects(() => auditService.applyAudit(BUSINESS, "auth", AUDIT), 400);

  calls.length = 0;
  state.audit = {
    id: AUDIT,
    auditCode: "AUDIT_2026_0001",
    status: "IN_PROGRESS",
    auditType: "RE_AUDIT",
    stockAuditItems: [
      {
        id: ITEM,
        variantId: VARIANT,
        lotItemId: LOT_ITEM,
        lotNumber: "LOT-1",
        snapshotQty: 5,
        countedQty: 8,
        variant: { costPrice: 10 },
        lotItem: {
          id: LOT_ITEM,
          lotId: "lot-1",
          expirationDate: new Date("2027-01-01"),
          manufacturingDate: null,
          status: "HEALTHY",
        },
      },
      {
        id: ITEM_2,
        variantId: VARIANT_2,
        lotItemId: null,
        lotNumber: "N1",
        newLotExpirationDate: new Date("2027-03-01"),
        snapshotQty: 0,
        countedQty: 0,
        variant: { costPrice: 4 },
        lotItem: null,
      },
    ],
  };
  state.balance = null;

  const result = await auditService.applyAudit(BUSINESS, "auth", AUDIT);

  assert.equal(result.itemsApplied, 2);
  assert.equal(result.ledgerEntriesCreated, 1);

  const ledger = call("ledgerCreateMany")[1].data;
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].transactionType, "STOCK_ADJUSTMENT_IN");
  assert.equal(ledger[0].quantityChanged, 3);
  assert.equal(ledger[0].balanceAfter, 12);
  assert.equal(ledger[0].referenceDocType, "STOCK_AUDIT");
  assert.equal(ledger[0].referenceDocId, AUDIT);
  assert.equal(ledger[0].totalCostValue.toFixed(2), "30.00");

  const created = calls.filter(([key]) => key === "balanceCreate").map(([, args]) => args.data);
  assert.equal(created.length, 2);
  assert.equal(created[0].quantityOnHand, 8);
  assert.equal(created[1].quantityOnHand, 0);

  assert.equal(call("variantUpdateMany")[1].data.isLockedForAudit, false);
  assert.equal(call("auditUpdate")[1].data.status, "DONE");
});

test("applying a new-lot row creates the batch and its lot item with the calculated status", async () => {
  state.audit = {
    id: AUDIT,
    auditCode: "AUDIT_2026_0001",
    status: "IN_PROGRESS",
    auditType: "NEW_LOTS",
    stockAuditItems: [
      {
        id: ITEM,
        variantId: VARIANT,
        lotItemId: null,
        lotNumber: "N1",
        newLotExpirationDate: new Date("2099-01-01"),
        newLotManufacturingDate: null,
        snapshotQty: 0,
        countedQty: 2,
        variant: { costPrice: 5 },
        lotItem: null,
      },
    ],
  };
  state.balance = null;

  await auditService.applyAudit(BUSINESS, "auth", AUDIT);

  assert.deepEqual(call("lotUpsert")[1].create, { businessId: BUSINESS, lotNumber: "N1" });

  const lotItem = call("lotItemCreate")[1].data;
  assert.equal(lotItem.variantId, VARIANT);
  assert.equal(lotItem.businessId, BUSINESS);
  assert.equal(lotItem.status, "HEALTHY");
  assert.equal(lotItem.isLockedForAudit, false);

  assert.equal(call("itemUpdate")[1].data.lotItemId, "new-lot-item");
  assert.equal(call("balanceCreate")[1].data.lotItemId, "new-lot-item");
});

test("a new lot without an expiry stops the apply and no balance is written", async () => {
  state.audit = {
    id: AUDIT,
    auditCode: "AUDIT_2026_0001",
    status: "IN_PROGRESS",
    auditType: "NEW_LOTS",
    stockAuditItems: [
      {
        id: ITEM,
        variantId: VARIANT,
        lotItemId: null,
        lotNumber: "N1",
        newLotExpirationDate: null,
        snapshotQty: 0,
        countedQty: 2,
        variant: { costPrice: 5 },
        lotItem: null,
      },
    ],
  };

  await rejects(() => auditService.applyAudit(BUSINESS, "auth", AUDIT), 400);
  assert.equal(wrote("balanceCreate"), false);
});

test("applying corrections unlocks a re-audit lot and preserves manual quarantine elsewhere", async () => {
  state.audit = {
    id: AUDIT,
    auditCode: "AUDIT_2026_0001",
    status: "IN_PROGRESS",
    auditType: "RE_AUDIT",
    stockAuditItems: [
      {
        id: ITEM,
        variantId: VARIANT,
        lotItemId: LOT_ITEM,
        lotNumber: "LOT-1",
        newLotExpirationDate: new Date("2099-02-01"),
        snapshotQty: 3,
        countedQty: 3,
        variant: { costPrice: 5 },
        lotItem: {
          id: LOT_ITEM,
          lotId: "lot-1",
          expirationDate: new Date("2027-01-01"),
          manufacturingDate: null,
          status: "QUARANTINED",
        },
      },
    ],
  };

  await auditService.applyAudit(BUSINESS, "auth", AUDIT);

  const update = call("lotItemUpdate")[1];
  assert.equal(update.data.expirationDate.toISOString().slice(0, 10), "2099-02-01");
  assert.equal(update.data.isLockedForAudit, false);
  assert.equal(update.data.status, "HEALTHY", "a re-audit recalculates the stored status");

  calls.length = 0;
  state.audit.auditType = "ADHOC";
  await auditService.applyAudit(BUSINESS, "auth", AUDIT);
  const manual = call("lotItemUpdate")[1];
  assert.equal("status" in manual.data, false, "a manual quarantine or scrap decision is never overwritten");
  assert.equal(manual.data.expirationDate.toISOString().slice(0, 10), "2099-02-01");
});

test("item listing clamps pagination and can be limited to the caller", async () => {
  state.audit = null;
  await rejects(() => auditService.getAuditItems(BUSINESS, "auth", AUDIT, { page: 1, pageSize: 20 }), 404);

  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.items = [itemRow()];
  const page = await auditService.getAuditItems(BUSINESS, "auth", AUDIT, { page: 0, pageSize: 5000 });
  assert.equal(page.pagination.page, 1);
  assert.equal(page.pagination.pageSize, 200);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].sku, "SKU-1");
  assert.equal(page.items[0].assignedTo.name, "Nhân viên");

  calls.length = 0;
  await auditService.getAuditItems(BUSINESS, "auth", AUDIT, { mine: true });
  assert.deepEqual(call("itemFindMany")[1].where, { auditId: AUDIT, assignedToUserId: OWNER });
});
