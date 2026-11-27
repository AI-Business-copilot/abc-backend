const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");

const BUSINESS = "22222222-2222-4222-8222-222222222222";
const OWNER = "11111111-1111-4111-8111-111111111111";
const STAFF = "77777777-7777-4777-8777-777777777777";
/** The second counter of a row. Every audit row is counted by two people. */
const STAFF_2 = "88888888-8888-4888-8888-888888888888";
const AUDIT = "44444444-4444-4444-8444-444444444444";
const ITEM = "55555555-5555-4555-8555-555555555555";
const ITEM_2 = "55555555-5555-4555-8555-555555555556";
const VARIANT = "33333333-3333-4333-8333-333333333333";
const VARIANT_2 = "33333333-3333-4333-8333-333333333334";
const LOT_ITEM = "66666666-6666-4666-8666-666666666666";
/** The count row of an employee and the evidence photo attached to it. */
const COUNT = "99999999-9999-4999-8999-999999999999";
const IMAGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** A full AUDIT_ITEM_SELECT row so formatAuditItem can run on mocked reads. */
const itemRow = (overrides = {}) => ({
  id: ITEM,
  variantId: VARIANT,
  lotItemId: null,
  lotNumber: "LOT-1",
  newLotExpirationDate: new Date("2027-01-01T00:00:00Z"),
  newLotManufacturingDate: null,
  auditId: AUDIT,
  snapshotQty: 0,
  countedQty: 5,
  countedDamagedQty: 0,
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
  secondCounterUser: null,
  secondCounterUserId: null,
  counts: [],
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
      status: "DRAFT",
      isLockedForAudit: false,
      countStartAt: null,
    },
    appliedAudit: { id: AUDIT, auditCode: "AUDIT_2026_0001", status: "DONE", auditType: "RE_AUDIT" },
    item: { id: ITEM, itemStatus: "IN_PROGRESS", auditId: AUDIT, assignedToUserId: OWNER, lotItemId: null, snapshotQty: 10, countedQty: 0, countedDamagedQty: 0, discrepancyReason: null },
    items: [],
    /** The audits the list endpoint returns. */
    audits: [],
    /** The audit the update endpoint writes back. */
    updatedAudit: null,
    /** The counter rows of a row: one per employee who counted it. */
    counts: [],
    /** The history records of a row: one per owner decision. */
    histories: [],
    /** The evidence photos of a count. */
    countImages: [
      {
        id: IMAGE,
        countId: COUNT,
        businessId: BUSINESS,
        storagePath: "p1",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        uploadedBy: STAFF,
        createdAt: new Date(),
        updatedAt: new Date(),
        uploadedByUser: { id: STAFF, fullName: "Nhân viên" },
        count: { counterUserId: STAFF },
      },
    ],
    /** The storage paths that were uploaded during the test. */
    uploads: [],
    /** The storage paths that were deleted during the test. */
    deletions: [],
    remaining: 1,
    updatedItem: { id: ITEM, itemStatus: "APPROVED", approvedAt: new Date(), approvedBy: OWNER },
    formattedRow: itemRow(),
    variants: [{ id: VARIANT }],
    lotItems: [{ id: LOT_ITEM, variantId: VARIANT }],
    lotRows: [{ id: LOT_ITEM, variantId: VARIANT, status: "HEALTHY", lot: { lotNumber: "LOT-1" } }],
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
    pendingScrap: 0,
    openScrapOrder: null,
    openScrapOrders: [],
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
    findMany: async (args) => {
      calls.push(["auditFindMany", args]);
      return state.audits;
    },
    count: async (args) => {
      calls.push(["auditCount", args]);
      return state.audits.length;
    },
    create: async (args) => {
      calls.push(["auditCreate", args]);
      return state.createdAudit;
    },
    update: async (args) => {
      calls.push(["auditUpdate", args]);
      return state.updatedAudit ?? state.appliedAudit;
    },
    delete: async (args) => {
      calls.push(["auditDelete", args]);
    },
  },
  stockAuditItem: {
    findFirst: async (args) => {
      calls.push(["itemFindFirst", args]);
      const where = args?.where ?? {};
      if (where.lotNumber !== undefined) return state.sameNewLot;
      if (where.variantId !== undefined && where.lotItemId !== undefined) return state.duplicateLotItem;
      // The counter rows ride along with the item so the service can compare them.
      return state.item ? { ...state.item, counts: state.counts } : state.item;
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
    delete: async (args) => {
      calls.push(["itemDelete", args]);
    },
  },
  stockAuditItemCount: {
    findUnique: async (args) => {
      calls.push(["countFindUnique", args]);
      const counterUserId = args?.where?.itemId_counterUserId?.counterUserId;
      return state.counts.find((c) => c.counterUserId === counterUserId) ?? null;
    },
    findMany: async (args) => {
      calls.push(["countFindMany", args]);
      return state.counts;
    },
    findFirst: async (args) => {
      calls.push(["countFindFirst", args]);
      const id = args?.where?.id;
      return state.counts.find((c) => c.id === id) ?? null;
    },
    upsert: async (args) => {
      calls.push(["countUpsert", args]);
      const counterUserId = args?.where?.itemId_counterUserId?.counterUserId;
      const existing = state.counts.find((c) => c.counterUserId === counterUserId);
      const row = {
        id: existing?.id ?? `count-${counterUserId}`,
        ...(existing ?? {}),
        ...(args?.create ?? {}),
      };
      if (existing) Object.assign(existing, row);
      else state.counts.push(row);
      return row;
    },
    update: async (args) => {
      calls.push(["countUpdate", args]);
      const counterUserId = args?.where?.itemId_counterUserId?.counterUserId;
      const row = state.counts.find((c) => c.counterUserId === counterUserId);
      if (row) Object.assign(row, args?.data ?? {});
      return row;
    },
    updateMany: async (args) => {
      calls.push(["countUpdateMany", args]);
      for (const row of state.counts) Object.assign(row, args?.data ?? {});
    },
    deleteMany: async (args) => {
      calls.push(["countDeleteMany", args]);
      state.counts = [];
    },
  },
  stockAuditItemHistory: {
    findFirst: async (args) => {
      calls.push(["historyFindFirst", args]);
      return state.histories[state.histories.length - 1] ?? null;
    },
    findMany: async (args) => {
      calls.push(["historyFindMany", args]);
      return state.histories;
    },
    create: async (args) => {
      calls.push(["historyCreate", args]);
      const row = { id: `history-${state.histories.length + 1}`, ...(args?.data ?? {}) };
      state.histories.push(row);
      return row;
    },
  },
  stockAuditItemCountImage: {
    findMany: async (args) => {
      calls.push(["countImageFindMany", args]);
      // The service filters the filed photos out of the live gallery.
      if (args?.where?.archivedAt === null) {
        return state.countImages.filter((image) => !image.archivedAt);
      }
      return state.countImages;
    },
    findFirst: async (args) => {
      calls.push(["countImageFindFirst", args]);
      return state.countImages[0] ?? null;
    },
    createMany: async (args) => {
      calls.push(["countImageCreateMany", args]);
      for (const row of args?.data ?? []) state.countImages.push({ id: `img-${state.countImages.length}`, ...row });
    },
    updateMany: async (args) => {
      calls.push(["countImageUpdateMany", args]);
      for (const row of state.countImages) Object.assign(row, args?.data ?? {});
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
  scrapOrder: {
    findMany: async (args) => {
      calls.push(["scrapFindMany", args]);
      return state.pendingScrap ? [{ lotItemId: LOT_ITEM, scrapCode: "SCRAP-TEST", status: "PENDING" }] : [];
    },
    findFirst: async (args) => {
      calls.push(["scrapFindFirst", args]);
      return state.pendingScrap ? { scrapCode: "SCRAP-TEST", status: "PENDING" } : null;
    },
    count: async (args) => {
      calls.push(["scrapCount", args]);
      return state.pendingScrap;
    },
    findFirst: async (args) => {
      calls.push(["scrapFindFirst", args]);
      return state.openScrapOrder;
    },
    findMany: async (args) => {
      calls.push(["scrapFindMany", args]);
      return state.openScrapOrders;
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
  /** The pessimistic row lock of an audit before it is applied. */
  $queryRaw: async () => [],
};

const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { prisma: db },
};

// Storage must never be contacted from a unit test.
const storagePath = require.resolve("../src/shared/infrastructure/storage/supabase-storage.ts");
require.cache[storagePath] = {
  id: storagePath,
  filename: storagePath,
  loaded: true,
  exports: {
    uploadObject: async (path) => {
      state.uploads.push(path);
    },
    deleteObjects: async (paths) => {
      state.deletions.push(...paths);
    },
    createSignedUrls: async () => new Map(),
  },
};

const { auditService } = require("../src/modules/inventory/services/audit.service.ts");
const { AuditImageService } = require("../src/modules/inventory/services/audit-image.service.ts");
const auditImageService = new AuditImageService();

beforeEach(resetState);

const wrote = (name) => calls.some(([key]) => key === name);
const call = (name) => calls.find(([key]) => key === name);
const rejects = (fn, statusCode) =>
  assert.rejects(fn, (err) => {
    assert.equal(err.statusCode, statusCode, `expected ${statusCode}, got ${err.statusCode}: ${err.message}`);
    return true;
  });

test("audit creation rejects an unknown type, a duplicate code and invalid rows", async () => {
  state.auditWithCode = { id: AUDIT };
  await rejects(
    () => auditService.createAudit(BUSINESS, "auth", { auditCode: "AUDIT_2026_0001" }),
    409,
  );
  state.auditWithCode = null;

  await rejects(
    () => auditService.createAudit(BUSINESS, "auth", { items: [{ variantId: VARIANT }] }),
    400,
  );
  await rejects(
    () => auditService.createAudit(BUSINESS, "auth", { items: [{ assignedToUserId: STAFF }] }),
    400,
  );
  // The second counter is required: every row is counted by two people.
  await rejects(
    () =>
      auditService.createAudit(BUSINESS, "auth", {
        items: [{ assignedToUserId: STAFF, variantId: VARIANT, lotItemId: LOT_ITEM }],
      }),
    400,
  );
  await rejects(
    () =>
      auditService.createAudit(BUSINESS, "auth", {
        items: [
          {
            assignedToUserId: STAFF,
            secondCounterUserId: STAFF_2,
            variantId: VARIANT,
          },
        ],
      }),
    400,
  );

  state.staffMemberships = [];
  await rejects(
    () =>
      auditService.createAudit(BUSINESS, "auth", {
        items: [
          {
            assignedToUserId: STAFF,
            secondCounterUserId: STAFF_2,
            variantId: VARIANT,
            lotItemId: LOT_ITEM,
          },
        ],
      }),
    400,
  );

  state.staffMemberships = [{ userId: STAFF }, { userId: STAFF_2 }];
  const row = {
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    variantId: VARIANT,
    lotItemId: LOT_ITEM,
  };
  await rejects(
    () => auditService.createAudit(BUSINESS, "auth", { items: [row, { ...row }] }),
    409,
  );

  assert.equal(wrote("auditCreate"), false, "no audit may be created when validation fails");
});

test("audit creation produces a draft and locks nothing", async () => {
  state.staffMemberships = [{ userId: STAFF }, { userId: STAFF_2 }];
  const created = await auditService.createAudit(BUSINESS, "auth", {
    items: [
      {
        assignedToUserId: STAFF,
        secondCounterUserId: STAFF_2,
        variantId: VARIANT,
        lotItemId: LOT_ITEM,
      },
    ],
  });

  assert.equal(created.auditCode, "AUDIT_2026_0001");
  assert.equal(created.itemCount, 1);
  assert.equal(created.affectedVariantCount, 1);

  // A draft locks nothing: the store keeps trading those SKUs while the owner prepares the audit.
  assert.equal(wrote("variantUpdateMany"), false, "a draft must not lock the variant");
  assert.equal(wrote("lotItemUpdateMany"), false, "a draft must not lock the lot item");

  const create = call("auditCreate")[1];
  assert.equal(create.data.status, "DRAFT");
  assert.equal(create.data.isLockedForAudit, false);
  assert.equal(create.data.countStartAt, null);

  const item = call("itemCreateMany")[1].data[0];
  assert.equal(item.snapshotQty, 7);
  assert.equal(item.lotNumber, "LOT-1");
  assert.equal(item.itemStatus, "IN_PROGRESS");
  assert.equal(item.countedQty, 0);
  assert.equal(item.secondCounterUserId, STAFF_2, "the row names both counters");
});

test("reassignment only moves an in-progress row to an active non-owner member", async () => {
  // Only the owner may change the people of a row.
  state.membership = { role: { code: "OWNER" } };

  await rejects(() => auditService.reassignAuditItem(BUSINESS, "auth", AUDIT, ITEM, {}), 400);

  // The second counter is required: every row is counted by two people.
  await rejects(
    () => auditService.reassignAuditItem(BUSINESS, "auth", AUDIT, ITEM, { assignedToUserId: STAFF }),
    400,
  );

  state.audit = null;
  await rejects(
    () =>
      auditService.reassignAuditItem(BUSINESS, "auth", AUDIT, ITEM, {
        assignedToUserId: STAFF,
        secondCounterUserId: STAFF_2,
      }),
    404,
  );

  state.audit = { id: AUDIT, status: "DONE" };
  await rejects(
    () =>
      auditService.reassignAuditItem(BUSINESS, "auth", AUDIT, ITEM, {
        assignedToUserId: STAFF,
        secondCounterUserId: STAFF_2,
      }),
    409,
  );

  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = null;
  await rejects(
    () =>
      auditService.reassignAuditItem(BUSINESS, "auth", AUDIT, ITEM, {
        assignedToUserId: STAFF,
        secondCounterUserId: STAFF_2,
      }),
    404,
  );

  state.item = { id: ITEM, itemStatus: "PENDING_APPROVAL" };
  await rejects(
    () =>
      auditService.reassignAuditItem(BUSINESS, "auth", AUDIT, ITEM, {
        assignedToUserId: STAFF,
        secondCounterUserId: STAFF_2,
      }),
    409,
  );

  state.item = { id: ITEM, itemStatus: "IN_PROGRESS" };
  state.staffMemberships = [];
  await rejects(
    () =>
      auditService.reassignAuditItem(BUSINESS, "auth", AUDIT, ITEM, {
        assignedToUserId: OWNER,
        secondCounterUserId: STAFF_2,
      }),
    400,
  );

  state.staffMemberships = [{ userId: STAFF }, { userId: STAFF_2 }];
  const result = await auditService.reassignAuditItem(BUSINESS, "auth", AUDIT, ITEM, {
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
  });

  assert.equal(call("itemUpdate")[1].data.assignedToUserId, STAFF);
  assert.equal(call("itemUpdate")[1].data.secondCounterUserId, STAFF_2);
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
  state.lotItemRow = {
    id: LOT_ITEM,
    expirationDate: new Date("2027-01-01T00:00:00Z"),
    manufacturingDate: null,
    lot: { lotNumber: "LOT-1" },
  };
  await rejects(() => auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, { countedQty: 3 }), 400);

  const saved = await auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
    countedQty: 3,
    discrepancyReason: "Hàng rơi",
  });
  // The count lands in the employee's own counter row, not on the item.
  assert.equal(call("countUpsert")[1].create.countedQty, 3);
  assert.equal(call("countUpsert")[1].create.discrepancyReason, "Hàng rơi");
  assert.equal(call("countUpsert")[1].create.counterUserId, OWNER);
  assert.equal(call("itemUpdate")[1].data.countedQty, 3);
  assert.equal(saved.id, ITEM);
});

test("counting keeps the lot the owner assigned and refuses to switch it", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = { id: ITEM, itemStatus: "IN_PROGRESS", assignedToUserId: OWNER, lotItemId: LOT_ITEM, variantId: VARIANT };
  state.lotItemRow = {
    id: LOT_ITEM,
    expirationDate: new Date("2027-01-01T00:00:00Z"),
    manufacturingDate: null,
    lot: { lotNumber: "LOT-1" },
  };

  await rejects(
    () =>
      auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
        countedQty: 2,
        discrepancyReason: "x",
        lotItemId: "66666666-6666-4666-8666-666666666667",
      }),
    400,
  );
  await rejects(
    () =>
      auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
        countedQty: 2,
        discrepancyReason: "x",
        lotItemId: null,
      }),
    400,
  );
});

test("an existing lot row stores only the dates the employee corrected", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
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

  // The date correction is stored on the employee's own counter row.
  const data = call("countUpsert")[1].create;
  assert.equal(data.newLotExpirationDate.toISOString().slice(0, 10), "2027-02-01");
  assert.equal(data.newLotManufacturingDate, null);
  assert.equal("lotItemId" in data, false, "a date correction does not re-point the row at another lot");
});

test("submission requires a lot and a reason, then clears the rejection", async () => {
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
    secondCounterUserId: null,
  };
  state.item = submitted;
  await rejects(() => auditService.submitAuditItem(BUSINESS, "auth", AUDIT, ITEM, {}), 400);

  // No count of their own yet: the employee has to count before submitting.
  state.item = { ...submitted, lotItemId: LOT_ITEM, lotNumber: "LOT-1", discrepancyReason: null };
  await rejects(() => auditService.submitAuditItem(BUSINESS, "auth", AUDIT, ITEM, {}), 400);

  // A count without a reason is still refused.
  state.counts = [{ id: "count-1", counterUserId: OWNER, countedQty: 5, discrepancyReason: null }];
  await rejects(() => auditService.submitAuditItem(BUSINESS, "auth", AUDIT, ITEM, {}), 400);

  state.counts = [{ id: "count-1", counterUserId: OWNER, countedQty: 5, discrepancyReason: "x" }];
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
  // The last approval applies the audit, and only the owner may do that.
  state.membership = { role: { code: "OWNER" } };
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
        discrepancyReason: "Kiểm kê",
        itemStatus: "APPROVED",
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
  // Only the owner may apply an audit.
  state.membership = { role: { code: "OWNER" } };

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
        discrepancyReason: "Hàng rơi",
        itemStatus: "APPROVED",
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
        discrepancyReason: "Kiểm kê",
        itemStatus: "APPROVED",
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

test("applying corrections unlocks a re-audit lot and preserves manual quarantine elsewhere", async () => {
  state.membership = { role: { code: "OWNER" } };
  state.audit = {
    id: AUDIT,
    auditCode: "AUDIT_2026_0001",
    status: "IN_PROGRESS",
    stockAuditItems: [
      {
        id: ITEM,
        variantId: VARIANT,
        lotItemId: LOT_ITEM,
        lotNumber: "LOT-1",
        newLotExpirationDate: new Date("2099-02-01"),
        snapshotQty: 3,
        countedQty: 3,
        discrepancyReason: "Kiểm kê",
        itemStatus: "APPROVED",
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
  // The lot is unlocked together with the variants, so another audit holding it keeps it locked.
  assert.equal(call("lotItemUpdateMany")[1].data.isLockedForAudit, false);
  assert.equal(
    update.data.status,
    "HEALTHY",
    "a re-audit releases a quarantine once the lot is sellable again",
  );
  assert.equal(update.data.quarantineQty, null, "a released quarantine leaves no quantity behind");
  assert.equal(update.data.quarantinedAt, null);
  assert.equal(update.data.quarantinedBy, null);
  assert.equal(update.data.quarantineNote, null);
});

test("a re-audit keeps an expired lot quarantined and never revives a scrapped one", async () => {
  state.membership = { role: { code: "OWNER" } };
  const expiredItem = (status) => ({
    id: ITEM,
    variantId: VARIANT,
    lotItemId: LOT_ITEM,
    lotNumber: "LOT-1",
    newLotExpirationDate: null,
    snapshotQty: 2,
    countedQty: 2,
    discrepancyReason: "Kiểm kê",
    itemStatus: "APPROVED",
    variant: { costPrice: 5 },
    lotItem: {
      id: LOT_ITEM,
      lotId: "lot-1",
      expirationDate: new Date("2020-01-01"),
      manufacturingDate: null,
      status,
    },
  });

  state.audit = {
    id: AUDIT,
    auditCode: "AUDIT_2026_0001",
    status: "IN_PROGRESS",
    auditType: "RE_AUDIT",
    stockAuditItems: [expiredItem("QUARANTINED")],
  };

  await auditService.applyAudit(BUSINESS, "auth", AUDIT);

  const quarantined = call("lotItemUpdate")[1];
  assert.equal("status" in quarantined.data, false, "expiry alone never releases a quarantine");
  assert.equal("quarantineQty" in quarantined.data, false, "the quarantine fields stay as they were");
  assert.equal(
    call("lotItemUpdateMany")[1].data.isLockedForAudit,
    false,
    "the re-audit still unlocks the lot",
  );

  calls.length = 0;
  state.audit.stockAuditItems = [
    { ...expiredItem("SCRAPPED"), lotItem: { ...expiredItem("SCRAPPED").lotItem, expirationDate: new Date("2099-01-01") } },
  ];
  await auditService.applyAudit(BUSINESS, "auth", AUDIT);

  const scrapped = call("lotItemUpdate")[1];
  assert.equal("status" in scrapped.data, false, "a scrap decision is never undone");
});

test("an apply is refused while a counted lot item has a pending scrap order", async () => {
  state.membership = { role: { code: "OWNER" } };
  state.audit = {
    id: AUDIT,
    auditCode: "AUDIT_2026_0001",
    status: "IN_PROGRESS",
    stockAuditItems: [
      {
        id: ITEM,
        variantId: VARIANT,
        lotItemId: LOT_ITEM,
        lotNumber: "LOT-1",
        newLotExpirationDate: null,
        snapshotQty: 2,
        countedQty: 2,
        discrepancyReason: "Kiểm kê",
        itemStatus: "APPROVED",
        variant: { costPrice: 5 },
        lotItem: {
          id: LOT_ITEM,
          lotId: "lot-1",
          expirationDate: new Date("2099-01-01"),
          manufacturingDate: null,
          status: "QUARANTINED",
        },
      },
    ],
  };
  state.openScrapOrder = { scrapCode: "PH-1", status: "PENDING" };

  await rejects(() => auditService.applyAudit(BUSINESS, "auth", AUDIT), 409);
  assert.equal(call("scrapFindFirst")[1].where.lotItemId.in[0], LOT_ITEM);
  assert.equal(wrote("balanceUpdate"), false);
  assert.equal(wrote("lotItemUpdate"), false);
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
  assert.deepEqual(call("itemFindMany")[1].where, {
    auditId: AUDIT,
    OR: [{ assignedToUserId: OWNER }, { secondCounterUserId: OWNER }],
  });
});

test("the second counter must be a different employee", async () => {
  state.membership = { role: { code: "OWNER" } };
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.staffMemberships = [{ userId: STAFF }, { userId: STAFF_2 }];
  state.lotRows = [{ id: LOT_ITEM, variantId: VARIANT, status: "HEALTHY", lot: { lotNumber: "LOT-1" } }];

  await rejects(
    () =>
      auditService.addAuditItems(BUSINESS, "auth", AUDIT, {
        items: [{ assignedToUserId: STAFF, secondCounterUserId: STAFF, variantId: VARIANT, lotItemId: LOT_ITEM }],
      }),
    400,
  );
});

test("every row needs a second counter", async () => {
  state.membership = { role: { code: "OWNER" } };
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.staffMemberships = [{ userId: STAFF }, { userId: STAFF_2 }];
  state.lotRows = [{ id: LOT_ITEM, variantId: VARIANT, status: "HEALTHY", lot: { lotNumber: "LOT-1" } }];

  // A row with only one person is refused: the second count is the point of the feature.
  await rejects(
    () =>
      auditService.addAuditItems(BUSINESS, "auth", AUDIT, {
        items: [{ assignedToUserId: STAFF, variantId: VARIANT, lotItemId: LOT_ITEM }],
      }),
    400,
  );

  await rejects(
    () =>
      auditService.reassignAuditItem(BUSINESS, "auth", AUDIT, ITEM, {
        assignedToUserId: STAFF,
      }),
    400,
  );
});

test("two counters who agree move the row on to the owner, and the owner sees both numbers", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  // The caller is the business owner, so they get the full comparison.
  state.membership = { role: { code: "OWNER" } };
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
  ];
  state.item = itemRow({
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    counts: state.counts,
  });

  const ownerView = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(ownerView.countAgreement, "AGREED");
  assert.equal(ownerView.counts.length, 2, "the owner compares both numbers");
});

test("a staff member never sees the other counter's number", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  // The caller is a staff member, not the owner.
  state.user = { id: STAFF, status: "ACTIVE", fullName: "Nhân viên", email: "staff@example.com" };
  state.membership = { role: { code: "STAFF" } };
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 3, countedDamagedQty: 0, submittedAt: new Date() },
  ];
  state.item = itemRow({
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    counts: state.counts,
  });

  const staffView = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(staffView.counts.length, 1, "a counter only sees their own number");
  assert.equal(staffView.counts[0].counterUserId, STAFF);
  assert.equal(staffView.counts[0].countedQty, 7);
  assert.equal(
    staffView.counts.some((c) => c.countedQty === 3),
    false,
    "the other counter's number is never sent to a staff member",
  );
});

test("two counters who disagree leave the row in progress for the owner to resolve", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 3, countedDamagedQty: 0, submittedAt: new Date() },
  ];
  state.item = itemRow({
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    counts: state.counts,
  });

  const view = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(view.countAgreement, "CONFLICT");
});

test("a row nobody has counted yet is not waiting for the other counter", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.counts = [];
  state.item = itemRow({
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    counts: state.counts,
  });

  const view = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(view.countAgreement, "NOT_STARTED");
});

test("a count that was saved but not sent for approval does not make the row wait", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 0, submittedAt: null },
  ];
  state.item = itemRow({
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    counts: state.counts,
  });

  const view = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(view.countAgreement, "NOT_STARTED");
});

test("the row waits for the other counter once one of them has sent their count", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
  ];
  state.item = itemRow({
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    counts: state.counts,
  });

  const view = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(view.countAgreement, "PENDING");
});

test("counters who found a different amount of broken goods have not settled the row", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  // The usable quantity matches, but the broken goods do not, so the row is still disputed.
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 2, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
  ];
  state.item = itemRow({
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    counts: state.counts,
  });

  const view = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(view.countAgreement, "CONFLICT");
});

test("counters who agree on the usable quantity and the broken goods settle the row", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 2, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 7, countedDamagedQty: 2, submittedAt: new Date() },
  ];
  state.item = itemRow({
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    counts: state.counts,
  });

  const view = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(view.countAgreement, "AGREED");
});

test("the owner sees the reason and the broken goods of every counter", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  // The caller is the business owner.
  state.membership = { role: { code: "OWNER" } };
  state.counts = [
    {
      id: "c1",
      counterUserId: STAFF,
      countedQty: 7,
      countedDamagedQty: 2,
      discrepancyReason: "Móp góc",
      submittedAt: new Date(),
    },
    {
      id: "c2",
      counterUserId: STAFF_2,
      countedQty: 7,
      countedDamagedQty: 0,
      discrepancyReason: "Sạch",
      submittedAt: new Date(),
    },
  ];
  state.item = itemRow({
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    counts: state.counts,
  });

  const view = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(view.counterDetails.length, 2, "both counters are listed");
  const first = view.counterDetails.find((c) => c.counterUserId === STAFF);
  assert.equal(first.discrepancyReason, "Móp góc");
  assert.equal(first.countedDamagedQty, 2);
  const second = view.counterDetails.find((c) => c.counterUserId === STAFF_2);
  assert.equal(second.discrepancyReason, "Sạch");
  assert.equal(second.countedDamagedQty, 0);
});

test("a staff member only ever sees their own reason and broken goods", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  // The caller is a staff member, not the owner.
  state.user = { id: STAFF, status: "ACTIVE", fullName: "Nhân viên", email: "staff@example.com" };
  state.membership = { role: { code: "STAFF" } };
  state.counts = [
    {
      id: "c1",
      counterUserId: STAFF,
      countedQty: 7,
      countedDamagedQty: 2,
      discrepancyReason: "Móp góc",
      submittedAt: new Date(),
    },
    {
      id: "c2",
      counterUserId: STAFF_2,
      countedQty: 7,
      countedDamagedQty: 0,
      discrepancyReason: "Sạch",
      submittedAt: new Date(),
    },
  ];
  state.item = itemRow({
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    counts: state.counts,
  });

  const view = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(view.counterDetails.length, 1, "only their own entry is sent");
  assert.equal(view.counterDetails[0].counterUserId, STAFF);
  assert.equal(
    view.counterDetails.some((c) => c.discrepancyReason === "Sạch"),
    false,
    "the other counter's reason is never sent to a staff member",
  );
});

test("the owner sends a disputed row back to both counters for another count", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = {
    id: ITEM,
    itemStatus: "IN_PROGRESS",
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    counts: state.counts,
  };
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 3, countedDamagedQty: 0, submittedAt: new Date() },
  ];
  state.formattedRow = itemRow({ secondCounterUserId: STAFF_2, counts: state.counts });

  await rejects(
    () => auditService.requestRecount(BUSINESS, "auth", AUDIT, ITEM, { reason: "  " }),
    400,
  );

  const result = await auditService.requestRecount(BUSINESS, "auth", AUDIT, ITEM, {
    reason: "Kiểm kê lại",
  });

  assert.equal(result.itemStatus, "IN_PROGRESS");
  const itemData = call("itemUpdate")[1].data;
  assert.equal(itemData.countedQty, 0, "the old number is cleared so it cannot be mistaken for the new one");
  assert.equal(itemData.rejectionReason, "Kiểm kê lại");
  // Both counters start over.
  assert.equal(call("countUpdateMany")[1].data.countedQty, 0);
});

test("a recount is written to the history before the numbers are cleared", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = {
    id: ITEM,
    itemStatus: "IN_PROGRESS",
    auditId: AUDIT,
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    snapshotQty: 10,
    countedQty: 7,
    countedDamagedQty: 1,
    discrepancyReason: "Móp góc",
    counts: state.counts,
  };
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 1, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 3, countedDamagedQty: 0, submittedAt: new Date() },
  ];
  state.formattedRow = itemRow({ secondCounterUserId: STAFF_2, counts: state.counts });

  await auditService.requestRecount(BUSINESS, "auth", AUDIT, ITEM, { reason: "Kiểm kê lại" });

  assert.equal(state.histories.length, 1, "the recount is recorded");
  const history = state.histories[0];
  assert.equal(history.action, "RECOUNT");
  assert.equal(history.reason, "Kiểm kê lại");
  assert.equal(history.revision, 1);
  assert.equal(history.actorId, OWNER);
  // The row's own numbers are copied.
  assert.equal(history.countedQty, 7);
  assert.equal(history.countedDamagedQty, 1);
  // Each counter's number is copied too, so the history says what they had found.
  const counters = history.counts.create;
  assert.equal(counters.length, 2);
  const staff = counters.find((c) => c.counterUserId === STAFF);
  assert.equal(staff.countedQty, 7);
  assert.equal(staff.countedDamagedQty, 1);
  assert.ok(staff.submittedAt, "the moment they submitted is kept");
  const second = counters.find((c) => c.counterUserId === STAFF_2);
  assert.equal(second.countedQty, 3);
});

test("rejecting a row writes it to the history and files its photos under it", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = {
    id: ITEM,
    itemStatus: "PENDING_APPROVAL",
    auditId: AUDIT,
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    snapshotQty: 10,
    countedQty: 7,
    countedDamagedQty: 2,
    discrepancyReason: "Móp góc",
    counts: state.counts,
  };
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 2, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 7, countedDamagedQty: 2, submittedAt: new Date() },
  ];
  state.formattedRow = itemRow({ secondCounterUserId: STAFF_2, counts: state.counts });

  await auditService.rejectAuditItem(BUSINESS, "auth", AUDIT, ITEM, { reason: "Sai lý do" });

  assert.equal(state.histories.length, 1, "the rejection is recorded");
  const history = state.histories[0];
  assert.equal(history.action, "REJECTED");
  assert.equal(history.reason, "Sai lý do");
  assert.equal(history.countedQty, 7);
  assert.equal(history.countedDamagedQty, 2);

  // The photos of that moment are filed under the record and leave the live gallery.
  const filed = call("countImageUpdateMany");
  assert.ok(filed, "the photos are filed under the history");
  assert.equal(filed[1].data.historyId, history.id);
  assert.ok(filed[1].data.archivedAt, "the photos are no longer part of the live gallery");
});

test("approving a row writes it to the history", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = {
    id: ITEM,
    itemStatus: "PENDING_APPROVAL",
    auditId: AUDIT,
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    snapshotQty: 10,
    countedQty: 7,
    countedDamagedQty: 0,
    discrepancyReason: "Móp góc",
    counts: state.counts,
  };
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
  ];
  state.formattedRow = itemRow({ secondCounterUserId: STAFF_2, counts: state.counts });

  await auditService.approveAuditItem(BUSINESS, "auth", AUDIT, ITEM);

  assert.equal(state.histories.length, 1, "the approval is recorded");
  const history = state.histories[0];
  assert.equal(history.action, "APPROVED");
  assert.equal(history.reason, null);
  assert.equal(history.countedQty, 7);
});

test("every decision on a row adds another record with the next revision", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = {
    id: ITEM,
    itemStatus: "PENDING_APPROVAL",
    auditId: AUDIT,
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
    snapshotQty: 10,
    countedQty: 7,
    countedDamagedQty: 0,
    discrepancyReason: "Móp góc",
    counts: state.counts,
  };
  // The two counters disagree, so the owner may send the row back for another count.
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 3, countedDamagedQty: 0, submittedAt: new Date() },
  ];
  state.formattedRow = itemRow({ secondCounterUserId: STAFF_2, counts: state.counts });

  await auditService.requestRecount(BUSINESS, "auth", AUDIT, ITEM, { reason: "Kiểm kê lại" });
  // The recount cleared the numbers, so the row is counted again before it can be rejected.
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
  ];
  state.item = { ...state.item, itemStatus: "PENDING_APPROVAL" };
  await auditService.rejectAuditItem(BUSINESS, "auth", AUDIT, ITEM, { reason: "Sai lý do" });

  assert.equal(state.histories.length, 2);
  assert.equal(state.histories[0].revision, 1);
  assert.equal(state.histories[0].action, "RECOUNT");
  assert.equal(state.histories[1].revision, 2);
  assert.equal(state.histories[1].action, "REJECTED");
});

test("only the owner may read the history of a row", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  // The caller is a staff member, not the owner.
  state.user = { id: STAFF, status: "ACTIVE", fullName: "Nhân viên", email: "staff@example.com" };
  state.membership = { role: { code: "STAFF" } };
  state.item = { id: ITEM, itemStatus: "IN_PROGRESS", auditId: AUDIT };

  await rejects(() => auditService.getItemHistory(BUSINESS, "auth", AUDIT, ITEM), 403);
});


test("a row whose counters agree cannot be sent back for a recount", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = {
    id: ITEM,
    itemStatus: "IN_PROGRESS",
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
  };
  state.counts = [
    { id: "c1", counterUserId: STAFF, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
    { id: "c2", counterUserId: STAFF_2, countedQty: 7, countedDamagedQty: 0, submittedAt: new Date() },
  ];

  await rejects(
    () => auditService.requestRecount(BUSINESS, "auth", AUDIT, ITEM, { reason: "Kiểm kê lại" }),
    409,
  );
});

test("a row with one counter cannot be sent back for a recount", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = {
    id: ITEM,
    itemStatus: "IN_PROGRESS",
    assignedToUserId: STAFF,
    secondCounterUserId: null,
  };
  state.counts = [{ id: "c1", counterUserId: STAFF, countedQty: 7, submittedAt: new Date() }];

  await rejects(
    () => auditService.requestRecount(BUSINESS, "auth", AUDIT, ITEM, { reason: "Kiểm kê lại" }),
    409,
  );
});

test("the owner cannot count a row on the employees' behalf", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  // The caller is the business owner, who is neither of the row's two counters.
  state.membership = { role: { code: "OWNER" } };
  state.item = itemRow({
    itemStatus: "IN_PROGRESS",
    assignedToUserId: STAFF,
    secondCounterUserId: STAFF_2,
  });

  await rejects(
    () =>
      auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
        countedQty: 3,
        discrepancyReason: "Hàng rơi",
      }),
    403,
  );
  assert.equal(wrote("countUpsert"), false, "the owner writes no count of their own");
});

/** A tiny but real JPEG, so the magic-byte check accepts it. */
const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** The counter of the row: a staff member, so the owner-only rules do not get in the way. */
function asCounter() {
  state.user = { id: STAFF, status: "ACTIVE", fullName: "Nhân viên", email: "staff@example.com" };
  state.membership = { role: { code: "STAFF" } };
}

test("broken goods cannot be counted without an evidence photo", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = { id: ITEM, itemStatus: "IN_PROGRESS", assignedToUserId: STAFF, lotItemId: null };
  asCounter();

  await rejects(
    () =>
      auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
        countedQty: 3,
        countedDamagedQty: 2,
        discrepancyReason: "Hàng hỏng",
      }),
    400,
  );
  assert.equal(wrote("countUpsert"), false, "the count is not saved without a photo");
});

test("a count with broken goods stores the evidence photos with it", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = { id: ITEM, itemStatus: "IN_PROGRESS", assignedToUserId: STAFF, lotItemId: null };
  asCounter();

  await auditService.updateCount(
    BUSINESS,
    "auth",
    AUDIT,
    ITEM,
    { countedQty: 3, countedDamagedQty: 2, discrepancyReason: "Hàng hỏng" },
    [{ buffer: jpegBuffer }],
  );

  assert.equal(wrote("countUpsert"), true, "the count is saved");
  const created = call("countImageCreateMany")[1].data;
  assert.equal(created.length, 1, "one photo row is written");
  assert.equal(created[0].countId, "count-" + STAFF, "the photo belongs to the counter's own count");
  assert.equal(created[0].uploadedBy, STAFF);
  assert.equal(created[0].mimeType, "image/jpeg");
  assert.equal(state.uploads.length, 1, "the file is uploaded");
  assert.ok(state.uploads[0].startsWith(`${BUSINESS}/audits/${AUDIT}/`), "the file is stored under the audit");
});

test("a count without broken goods needs no photo", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = { id: ITEM, itemStatus: "IN_PROGRESS", assignedToUserId: STAFF, lotItemId: null };
  asCounter();

  await auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, {
    countedQty: 3,
    discrepancyReason: "Hàng rơi",
  });

  assert.equal(wrote("countUpsert"), true, "the count is saved");
  assert.equal(wrote("countImageCreateMany"), false, "no photo row is written");
  assert.equal(state.uploads.length, 0, "nothing is uploaded");
});

test("a file that is not a real image is refused", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  state.item = { id: ITEM, itemStatus: "IN_PROGRESS", assignedToUserId: STAFF, lotItemId: null };
  asCounter();

  await rejects(
    () =>
      auditService.updateCount(
        BUSINESS,
        "auth",
        AUDIT,
        ITEM,
        { countedQty: 3, countedDamagedQty: 1, discrepancyReason: "Hàng hỏng" },
        [{ buffer: Buffer.from("not an image at all") }],
      ),
    415,
  );
  assert.equal(state.uploads.length, 0, "nothing is uploaded");
});

test("a staff member never sees the other counter's photos", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  // The caller is a staff member, not the owner.
  asCounter();
  state.counts = [
    {
      id: "c1",
      counterUserId: STAFF,
      countedQty: 7,
      countedDamagedQty: 0,
      submittedAt: new Date(),
      images: [
        {
          id: "i1",
          storagePath: "p1",
          mimeType: "image/jpeg",
          sizeBytes: 10,
          uploadedBy: STAFF,
          createdAt: new Date(),
          uploadedByUser: { id: STAFF, fullName: "Nhân viên" },
        },
      ],
    },
    {
      id: "c2",
      counterUserId: STAFF_2,
      countedQty: 7,
      countedDamagedQty: 0,
      submittedAt: new Date(),
      images: [
        {
          id: "i2",
          storagePath: "p2",
          mimeType: "image/jpeg",
          sizeBytes: 10,
          uploadedBy: STAFF_2,
          createdAt: new Date(),
          uploadedByUser: { id: STAFF_2, fullName: "Nhân viên hai" },
        },
      ],
    },
  ];
  state.item = itemRow({ secondCounterUserId: STAFF_2 });

  const view = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(view.counts.length, 1, "only the caller's own count is returned");
  assert.equal(view.counts[0].images.length, 1, "the other counter's photos are never sent");
  assert.equal(view.counts[0].images[0].id, "i1");
});

test("the owner sees both counters' photos", async () => {
  state.audit = { id: AUDIT, status: "IN_PROGRESS" };
  // The caller is the business owner.
  state.user = { id: OWNER, status: "ACTIVE", fullName: "Chủ cửa hàng", email: "owner@example.com" };
  state.membership = { role: { code: "OWNER" } };
  state.counts = [
    {
      id: "c1",
      counterUserId: STAFF,
      countedQty: 7,
      countedDamagedQty: 1,
      submittedAt: new Date(),
      images: [
        {
          id: "i1",
          storagePath: "p1",
          mimeType: "image/jpeg",
          sizeBytes: 10,
          uploadedBy: STAFF,
          createdAt: new Date(),
          uploadedByUser: { id: STAFF, fullName: "Nhân viên" },
        },
      ],
    },
    {
      id: "c2",
      counterUserId: STAFF_2,
      countedQty: 7,
      countedDamagedQty: 1,
      submittedAt: new Date(),
      images: [
        {
          id: "i2",
          storagePath: "p2",
          mimeType: "image/jpeg",
          sizeBytes: 10,
          uploadedBy: STAFF_2,
          createdAt: new Date(),
          uploadedByUser: { id: STAFF_2, fullName: "Nhân viên hai" },
        },
      ],
    },
  ];
  state.item = itemRow({ secondCounterUserId: STAFF_2 });

  const view = await auditService.getAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.equal(view.counts.length, 2, "the owner sees both counters");
  assert.equal(view.counts[0].images.length, 1);
  assert.equal(view.counts[1].images.length, 1);
  assert.equal(view.counts[1].images[0].id, "i2");
});

test("the owner may read the signed photos of any count", async () => {
  state.counts = [
    {
      id: COUNT,
      counterUserId: STAFF,
      countedQty: 7,
      countedDamagedQty: 1,
      submittedAt: new Date(),
      images: [],
    },
  ];

  const images = await auditImageService.listImages(BUSINESS, COUNT, OWNER, true);
  assert.equal(images.length, 1);
  assert.equal(images[0].id, IMAGE);
  assert.equal(images[0].uploadedByName, "Nhân viên");
});

test("a counter may read their own signed photos", async () => {
  state.counts = [
    {
      id: COUNT,
      counterUserId: STAFF,
      countedQty: 7,
      countedDamagedQty: 1,
      submittedAt: new Date(),
      images: [],
    },
  ];

  const images = await auditImageService.listImages(BUSINESS, COUNT, STAFF, false);
  assert.equal(images.length, 1);
  assert.equal(images[0].id, IMAGE);
});

test("a counter cannot read the other counter's signed photos", async () => {
  state.counts = [
    {
      id: COUNT,
      counterUserId: STAFF,
      countedQty: 7,
      countedDamagedQty: 1,
      submittedAt: new Date(),
      images: [],
    },
  ];

  // STAFF_2 is not the counter of this count, so the blind count must stay blind.
  await rejects(() => auditImageService.listImages(BUSINESS, COUNT, STAFF_2, false), 403);
  await rejects(() => auditImageService.getImage(BUSINESS, IMAGE, STAFF_2, false), 403);
});

test("a single photo is only readable by the owner or the counter who took it", async () => {
  state.counts = [
    {
      id: COUNT,
      counterUserId: STAFF,
      countedQty: 7,
      countedDamagedQty: 1,
      submittedAt: new Date(),
      images: [],
    },
  ];

  const image = await auditImageService.getImage(BUSINESS, IMAGE, STAFF, false);
  assert.equal(image.id, IMAGE);
  const ownerImage = await auditImageService.getImage(BUSINESS, IMAGE, OWNER, true);
  assert.equal(ownerImage.id, IMAGE);
});

// ---------------------------------------------------------------------------
// F07 audit lifecycle: DRAFT -> IN_PROGRESS -> DONE, with delete and cancel.
// ---------------------------------------------------------------------------

/** The draft the owner is about to start. */
const draftAudit = (overrides = {}) => ({
  id: AUDIT,
  auditCode: "AUDIT_2026_0001",
  status: "DRAFT",
  stockAuditItems: [
    {
      id: ITEM,
      variantId: VARIANT,
      lotItemId: LOT_ITEM,
      assignedToUserId: STAFF,
      secondCounterUserId: STAFF_2,
    },
  ],
  ...overrides,
});

/** The running audit the owner is about to cancel. */
const runningAudit = (overrides = {}) => ({
  id: AUDIT,
  auditCode: "AUDIT_2026_0001",
  status: "IN_PROGRESS",
  stockAuditItems: [{ id: ITEM, variantId: VARIANT, lotItemId: LOT_ITEM }],
  ...overrides,
});

/** The owner of the business. */
const asOwner = () => {
  state.user = { id: OWNER, status: "ACTIVE", fullName: "Chủ cửa hàng", email: "owner@example.com" };
  state.membership = { role: { code: "OWNER" } };
};

/** A staff member of the business. */
const asStaff = () => {
  state.user = { id: STAFF, status: "ACTIVE", fullName: "Nhân viên", email: "staff@example.com" };
  state.membership = { role: { code: "STAFF" } };
};

test("starting a draft locks the SKUs, refreshes the snapshot and starts the count", async () => {
  asOwner();
  state.staffMemberships = [{ userId: STAFF }, { userId: STAFF_2 }];
  state.lotRows = [{ id: LOT_ITEM, variantId: VARIANT, status: "HEALTHY", lot: { lotNumber: "LOT-1" } }];
  state.audit = draftAudit();
  state.updatedAudit = {
    id: AUDIT,
    auditCode: "AUDIT_2026_0001",
    status: "IN_PROGRESS",
    isLockedForAudit: true,
    countStartAt: new Date("2026-11-23T00:00:00Z"),
  };

  const started = await auditService.startAudit(BUSINESS, "auth", AUDIT);
  assert.equal(started.status, "IN_PROGRESS");

  // The SKUs are frozen from the moment counting starts.
  const lock = call("variantUpdateMany")[1];
  assert.deepEqual(lock.where, { id: { in: [VARIANT] } });
  assert.equal(lock.data.isLockedForAudit, true);
  const lotLock = call("lotItemUpdateMany")[1];
  assert.equal(lotLock.data.isLockedForAudit, true);

  // The snapshot is read again, so the audit compares against the stock of now.
  const update = call("itemUpdate")[1];
  assert.equal(update.where.id, ITEM);
  assert.equal(update.data.snapshotQty, 7);

  const write = call("auditUpdate")[1];
  assert.equal(write.data.status, "IN_PROGRESS");
  assert.equal(write.data.isLockedForAudit, true);
  assert.ok(write.data.countStartAt instanceof Date);
});

test("starting a draft needs rows and a draft status", async () => {
  asOwner();
  state.audit = draftAudit({ stockAuditItems: [] });
  await rejects(() => auditService.startAudit(BUSINESS, "auth", AUDIT), 400);

  state.audit = runningAudit();
  await rejects(() => auditService.startAudit(BUSINESS, "auth", AUDIT), 409);

  state.audit = null;
  await rejects(() => auditService.startAudit(BUSINESS, "auth", AUDIT), 404);
});

test("starting a draft is refused when the lot was scrapped in the meantime", async () => {
  asOwner();
  state.staffMemberships = [{ userId: STAFF }, { userId: STAFF_2 }];
  state.lotRows = [{ id: LOT_ITEM, variantId: VARIANT, status: "SCRAPPED", lot: { lotNumber: "LOT-1" } }];
  state.audit = draftAudit();

  await rejects(() => auditService.startAudit(BUSINESS, "auth", AUDIT), 409);
  assert.equal(wrote("auditUpdate"), false, "a refused start must not lock anything");
});

test("a draft can be deleted and its photos leave storage with it", async () => {
  asOwner();
  state.audit = draftAudit();

  await auditService.deleteAudit(BUSINESS, "auth", AUDIT);

  assert.ok(wrote("auditDelete"), "the audit row is deleted");
  assert.deepEqual(state.deletions, ["p1"], "the photos of the audit are removed from storage");
});

test("a running audit cannot be deleted", async () => {
  asOwner();
  state.audit = runningAudit();

  await rejects(() => auditService.deleteAudit(BUSINESS, "auth", AUDIT), 409);
  assert.equal(wrote("auditDelete"), false);
});

test("only the owner may delete a draft", async () => {
  asStaff();
  state.audit = draftAudit();

  await rejects(() => auditService.deleteAudit(BUSINESS, "auth", AUDIT), 403);
  assert.equal(wrote("auditDelete"), false);
});

test("one row of a draft can be deleted, but a running audit keeps its rows", async () => {
  asOwner();
  state.audit = draftAudit();

  await auditService.deleteAuditItem(BUSINESS, "auth", AUDIT, ITEM);
  assert.ok(wrote("itemDelete"), "the row is deleted");
  assert.deepEqual(state.deletions, ["p1"], "the photos of the row are removed from storage");

  calls.length = 0;
  state.audit = runningAudit();
  await rejects(() => auditService.deleteAuditItem(BUSINESS, "auth", AUDIT, ITEM), 409);
  assert.equal(wrote("itemDelete"), false);
});

test("cancelling a running audit unlocks the SKUs it holds", async () => {
  asOwner();
  state.audit = runningAudit();
  state.updatedAudit = {
    id: AUDIT,
    auditCode: "AUDIT_2026_0001",
    status: "CANCELLED",
    completedAt: new Date("2026-11-23T00:00:00Z"),
  };

  const cancelled = await auditService.cancelAudit(BUSINESS, "auth", AUDIT);
  assert.equal(cancelled.status, "CANCELLED");

  const unlock = call("variantUpdateMany")[1];
  assert.deepEqual(unlock.where, { id: { in: [VARIANT] } });
  assert.equal(unlock.data.isLockedForAudit, false);
  const lotUnlock = call("lotItemUpdateMany")[1];
  assert.equal(lotUnlock.data.isLockedForAudit, false);

  const write = call("auditUpdate")[1];
  assert.equal(write.data.status, "CANCELLED");
  assert.equal(write.data.isLockedForAudit, false);
});

test("cancelling leaves a SKU locked when another running audit still holds it", async () => {
  asOwner();
  state.audit = runningAudit();
  state.audits = [
    {
      id: "other-audit",
      status: "IN_PROGRESS",
      stockAuditItems: [{ variantId: VARIANT }],
    },
  ];
  state.updatedAudit = { id: AUDIT, auditCode: "AUDIT_2026_0001", status: "CANCELLED", completedAt: new Date() };

  await auditService.cancelAudit(BUSINESS, "auth", AUDIT);

  assert.equal(wrote("variantUpdateMany"), false, "the other audit still needs the SKU");
  // The lot item is only held by this audit, so it is freed.
  const lotUnlock = call("lotItemUpdateMany")[1];
  assert.equal(lotUnlock.data.isLockedForAudit, false);
});

test("only a running audit can be cancelled", async () => {
  asOwner();
  state.audit = draftAudit();
  await rejects(() => auditService.cancelAudit(BUSINESS, "auth", AUDIT), 409);

  state.audit = null;
  await rejects(() => auditService.cancelAudit(BUSINESS, "auth", AUDIT), 404);
});

test("a staff member never sees a draft and cannot count one", async () => {
  asStaff();
  state.audit = draftAudit();

  await rejects(() => auditService.getAudit(BUSINESS, "auth", AUDIT), 404);
  await rejects(() => auditService.getAuditItems(BUSINESS, "auth", AUDIT, { page: 1, pageSize: 20 }), 404);

  // The list never offers a draft to a staff member.
  state.audits = [];
  await auditService.listAudits(BUSINESS, { authUserId: "auth", status: "DRAFT" });
  assert.equal(call("auditFindMany")[1].where.status, "__no_draft__");

  calls.length = 0;
  await auditService.listAudits(BUSINESS, { authUserId: "auth", status: "" });
  assert.deepEqual(call("auditFindMany")[1].where.status, { not: "DRAFT" });

  // A draft cannot be counted: the counting is only open while the audit is running.
  state.item = {
    id: ITEM,
    itemStatus: "IN_PROGRESS",
    auditId: AUDIT,
    assignedToUserId: STAFF,
    lotItemId: null,
  };
  await rejects(
    () => auditService.updateCount(BUSINESS, "auth", AUDIT, ITEM, { countedQty: 3, discrepancyReason: "x" }),
    409,
  );
});

test("the owner sees the drafts in the list", async () => {
  asOwner();
  state.audits = [];

  await auditService.listAudits(BUSINESS, { authUserId: "auth", status: "DRAFT" });
  assert.equal(call("auditFindMany")[1].where.status, "DRAFT");

  calls.length = 0;
  await auditService.listAudits(BUSINESS, { authUserId: "auth", status: "" });
  assert.equal(call("auditFindMany")[1].where.status, undefined);
});
