const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");

const BUSINESS = "22222222-2222-4222-8222-222222222222";
const STAFF = "11111111-1111-4111-8111-111111111111";
const OWNER = "99999999-9999-4999-8999-999999999999";
const ORDER = "44444444-4444-4444-8444-444444444444";
const LOT_ITEM = "66666666-6666-4666-8666-666666666666";
const VARIANT = "33333333-3333-4333-8333-333333333333";
const IMAGE_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMAGE_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const staffActor = { userId: STAFF, role: "STAFF" };
const ownerActor = { userId: OWNER, role: "OWNER" };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const webp = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from([0x01]),
]);

let state;
let calls;
let uploads;

const resetState = () => {
  calls = [];
  uploads = [];
  state = {
    locked: { id: ORDER, status: "PENDING", created_by: STAFF },
    lotItem: {
      id: LOT_ITEM,
      businessId: BUSINESS,
      variantId: VARIANT,
      status: "QUARANTINED",
      quarantineQty: 3,
      expirationDate: new Date("2027-01-01T00:00:00Z"),
      variant: { id: VARIANT, costPrice: new Prisma.Decimal("10") },
    },
    order: {
      id: ORDER,
      businessId: BUSINESS,
      variantId: VARIANT,
      lotItemId: LOT_ITEM,
      scrapQty: 3,
      unitCost: new Prisma.Decimal("10"),
      scrapSource: "SELLABLE_STOCK",
      status: "PENDING",
      createdBy: STAFF,
    },
    images: [{ id: IMAGE_1 }],
    balance: { id: "balance-1", quantityOnHand: 10, damagedQuantity: 2 },
    reduceCount: 1,
    variantTotal: { _sum: { quantityOnHand: 5 } },
    lotStock: { _sum: { quantityOnHand: 0, damagedQuantity: 0 } },
    lastScrapCode: null,
    pendingCount: 0,
    createdOrder: {
      id: ORDER,
      scrapCode: "SCRAP-2026-00001",
      status: "PENDING",
      scrapQty: 3,
      scrapSource: "SELLABLE_STOCK",
      variant: { id: VARIANT, sku: "SKU-1", template: { name: "Sữa rửa mặt" } },
    },
    updatedOrder: {
      id: ORDER,
      status: "COMPLETED",
      variant: { id: VARIANT, sku: "SKU-1", template: { name: "Sữa rửa mặt" } },
    },
    statusGroups: [],
    sourceGroups: [],
    lossAggregate: { _sum: { totalLossValue: null } },
  };
};

const db = {
  scrapOrder: {
    findFirst: async (args) => {
      calls.push(["orderFindFirst", args]);
      if (args?.where?.scrapCode) return state.lastScrapCode;
      return state.order;
    },
    findFirstOrThrow: async (args) => {
      calls.push(["orderFindFirstOrThrow", args]);
      return state.order;
    },
    count: async (args) => {
      calls.push(["orderCount", args]);
      return state.pendingCount;
    },
    create: async (args) => {
      calls.push(["orderCreate", args]);
      return state.createdOrder;
    },
    update: async (args) => {
      calls.push(["orderUpdate", args]);
      return state.updatedOrder;
    },
    groupBy: async (args) => {
      calls.push(["orderGroupBy", args]);
      return args?.by?.includes("scrapSource") ? state.sourceGroups : state.statusGroups;
    },
    aggregate: async (args) => {
      calls.push(["orderAggregate", args]);
      return state.lossAggregate;
    },
  },
  productLotItem: {
    findFirst: async (args) => {
      calls.push(["lotItemFindFirst", args]);
      return state.lotItem;
    },
    findFirstOrThrow: async (args) => {
      calls.push(["lotItemFindFirstOrThrow", args]);
      return state.lotItem;
    },
    update: async (args) => {
      calls.push(["lotItemUpdate", args]);
      return state.lotItem;
    },
  },
  inventoryBalance: {
    findFirst: async (args) => {
      calls.push(["balanceFindFirst", args]);
      return state.balance;
    },
    updateMany: async (args) => {
      calls.push(["balanceUpdateMany", args]);
      return { count: state.reduceCount };
    },
    aggregate: async (args) => {
      calls.push(["balanceAggregate", args]);
      return args?.where?.lotItemId ? state.lotStock : state.variantTotal;
    },
  },
  scrapOrderImage: {
    findMany: async (args) => {
      calls.push(["imageFindMany", args]);
      return state.images;
    },
  },
  inventoryLedger: {
    create: async (args) => {
      calls.push(["ledgerCreate", args]);
    },
  },
  $queryRaw: async () => {
    calls.push(["queryRaw"]);
    return [state.locked];
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

// Storage must never be contacted from a unit test.
const storagePath = require.resolve("../src/shared/infrastructure/storage/supabase-storage.ts");
require.cache[storagePath] = {
  id: storagePath,
  filename: storagePath,
  loaded: true,
  exports: {
    uploadObject: async (path) => {
      uploads.push(path);
    },
    deleteObjects: async () => {},
    createSignedUrls: async () => new Map(),
  },
};

const { ScrapService, REJECTION_REASON_CODES } = require("../src/modules/inventory/services/scrap.service.ts");
const { ScrapImageService, MAX_IMAGES_PER_ORDER } = require("../src/modules/inventory/services/scrap-image.service.ts");
const { assertOwner, assertStaff, assertUuid } = require("../src/modules/inventory/services/scrap-access.ts");

const service = new ScrapService();
const images = new ScrapImageService();

beforeEach(resetState);

const call = (name) => calls.find(([key]) => key === name);
const rejects = (fn, statusCode) =>
  assert.rejects(fn, (err) => {
    assert.equal(err.statusCode, statusCode, `expected ${statusCode}, got ${err.statusCode}: ${err.message}`);
    return true;
  });

test("scrap access rules separate staff from the owner and reject malformed ids", () => {
  assert.doesNotThrow(() => assertStaff(staffActor));
  assert.throws(() => assertStaff(ownerActor), (err) => err.statusCode === 403);
  assert.throws(() => assertStaff({ userId: STAFF, role: "" }), (err) => err.statusCode === 403);

  assert.doesNotThrow(() => assertOwner(ownerActor));
  assert.throws(() => assertOwner(staffActor), (err) => err.statusCode === 403);

  assert.equal(assertUuid(ORDER, "Scrap order"), ORDER);
  assert.throws(() => assertUuid("not-a-uuid", "Scrap order"), (err) => err.statusCode === 404);
  assert.throws(() => assertUuid(undefined, "Scrap order"), (err) => err.statusCode === 404);
});

test("evidence photos must be one to ten real JPEG, PNG or WebP images", () => {
  assert.throws(() => images.prepareImages(undefined), (err) => err.statusCode === 400);
  assert.throws(() => images.prepareImages([]), (err) => err.statusCode === 400);
  assert.throws(
    () => images.prepareImages(Array.from({ length: MAX_IMAGES_PER_ORDER + 1 }, () => ({ buffer: jpeg }))),
    (err) => err.statusCode === 400,
  );
  assert.throws(() => images.prepareImages([{ buffer: Buffer.from("not an image") }]), (err) => err.statusCode === 415);
  assert.throws(() => images.prepareImages([{ buffer: Buffer.alloc(0) }]), (err) => err.statusCode === 415);

  assert.deepEqual(
    images.prepareImages([{ buffer: jpeg }, { buffer: png }, { buffer: webp }]).map((image) => image.mimeType),
    ["image/jpeg", "image/png", "image/webp"],
  );
});

test("only a staff member can open a scrap order for a quarantined lot", async () => {
  await rejects(
    () => service.createScrapOrder(BUSINESS, ownerActor, { lotItemId: LOT_ITEM, scrapReason: "Hỏng" }, [{ buffer: jpeg }]),
    403,
  );

  await rejects(
    () => service.createScrapOrder(BUSINESS, staffActor, { lotItemId: LOT_ITEM, scrapReason: " " }, [{ buffer: jpeg }]),
    400,
  );

  state.lotItem = null;
  await rejects(
    () => service.createScrapOrder(BUSINESS, staffActor, { lotItemId: LOT_ITEM, scrapReason: "Hỏng" }, [{ buffer: jpeg }]),
    404,
  );

  state.lotItem = { ...state.lotItem, status: "UNUSABLE" };
  await rejects(
    () => service.createScrapOrder(BUSINESS, staffActor, { lotItemId: LOT_ITEM, scrapReason: "Hỏng" }, [{ buffer: jpeg }]),
    409,
  );
});

test("scrap creation checks the quantity, the source and the available stock", async () => {
  const files = [{ buffer: jpeg }];
  const base = { lotItemId: LOT_ITEM, scrapReason: "Hỏng" };

  await rejects(() => service.createScrapOrder(BUSINESS, staffActor, { ...base, scrapQty: 4 }, files), 409);
  await rejects(() => service.createScrapOrder(BUSINESS, staffActor, { ...base, scrapQty: 0 }, files), 400);
  await rejects(() => service.createScrapOrder(BUSINESS, staffActor, { ...base, scrapQty: 1.5 }, files), 400);
  await rejects(
    () => service.createScrapOrder(BUSINESS, staffActor, { ...base, scrapSource: "SHELF" }, files),
    400,
  );

  state.lotItem = { ...state.lotItem, quarantineQty: null };
  await rejects(() => service.createScrapOrder(BUSINESS, staffActor, base, files), 400);

  state.lotItem = { ...state.lotItem, quarantineQty: 3 };
  state.balance = { id: "balance-1", quantityOnHand: 1, damagedQuantity: 0 };
  await rejects(() => service.createScrapOrder(BUSINESS, staffActor, { ...base, scrapQty: 2 }, files), 409);

  state.balance = { id: "balance-1", quantityOnHand: 10, damagedQuantity: 1 };
  await rejects(
    () => service.createScrapOrder(BUSINESS, staffActor, { ...base, scrapQty: 2, scrapSource: "DAMAGED_STOCK" }, files),
    409,
  );

  state.balance = { id: "balance-1", quantityOnHand: 10, damagedQuantity: 2 };
  state.pendingCount = 1;
  await rejects(() => service.createScrapOrder(BUSINESS, staffActor, { ...base, scrapQty: 2 }, files), 409);
  assert.equal(uploads.length, 0, "no photo is uploaded when the order cannot be created");
});

test("a scrap order stores its photos, the quarantined quantity and a running code", async () => {
  state.lastScrapCode = { scrapCode: "SCRAP-2026-00001" };

  const created = await service.createScrapOrder(
    BUSINESS,
    staffActor,
    { lotItemId: LOT_ITEM, scrapReason: "  Hộp móp  " },
    [{ buffer: jpeg }, { buffer: png }],
  );

  const data = call("orderCreate")[1].data;
  assert.equal(data.businessId, BUSINESS);
  assert.equal(data.variantId, VARIANT);
  assert.equal(data.scrapQty, 3, "the quarantined quantity is the default");
  assert.equal(data.scrapReason, "Hộp móp");
  assert.equal(data.scrapSource, "SELLABLE_STOCK");
  assert.equal(data.status, "PENDING");
  assert.equal(data.createdBy, STAFF);
  assert.equal(data.scrapCode, "SCRAP-2026-00002");
  assert.equal(data.images.create.length, 2);
  assert.equal(data.images.create[0].businessId, BUSINESS);
  assert.equal(data.images.create[0].mimeType, "image/jpeg");
  assert.equal(uploads.length, 2);
  assert.equal(created.id, ORDER);
});

test("scrap approval needs an owner, the reviewed photos and a quarantined lot", async () => {
  await rejects(() => service.approveScrapOrder(BUSINESS, staffActor, ORDER, { reviewedImageIds: [] }), 403);
  await rejects(() => service.approveScrapOrder(BUSINESS, ownerActor, ORDER, {}), 400);
  await rejects(() => service.approveScrapOrder(BUSINESS, ownerActor, ORDER, { reviewedImageIds: [1] }), 400);

  state.locked = { id: ORDER, status: "COMPLETED", created_by: STAFF };
  await rejects(() => service.approveScrapOrder(BUSINESS, ownerActor, ORDER, { reviewedImageIds: [IMAGE_1] }), 409);

  state.locked = { id: ORDER, status: "PENDING", created_by: STAFF };
  state.images = [];
  await rejects(() => service.approveScrapOrder(BUSINESS, ownerActor, ORDER, { reviewedImageIds: [] }), 409);

  state.images = [{ id: IMAGE_1 }];
  await rejects(
    () => service.approveScrapOrder(BUSINESS, ownerActor, ORDER, { reviewedImageIds: [IMAGE_1, IMAGE_2] }),
    409,
  );

  state.lotItem = { ...state.lotItem, status: "UNUSABLE" };
  await rejects(() => service.approveScrapOrder(BUSINESS, ownerActor, ORDER, { reviewedImageIds: [IMAGE_1] }), 409);

  state.lotItem = { ...state.lotItem, status: "QUARANTINED" };
  state.reduceCount = 0;
  await rejects(() => service.approveScrapOrder(BUSINESS, ownerActor, ORDER, { reviewedImageIds: [IMAGE_1] }), 409);
  assert.equal(calls.some(([key]) => key === "ledgerCreate"), false);
});

test("approval reduces sellable stock and scraps a lot left with nothing", async () => {
  const result = await service.approveScrapOrder(BUSINESS, ownerActor, ORDER, { reviewedImageIds: [IMAGE_1] });

  const reduction = call("balanceUpdateMany")[1];
  assert.equal(reduction.where.quantityOnHand.gte, 3);
  assert.equal(reduction.data.quantityOnHand.decrement, 3);

  const ledger = call("ledgerCreate")[1].data;
  assert.equal(ledger.transactionType, "SCRAP_DISPOSAL");
  assert.equal(ledger.quantityChanged, -3);
  assert.equal(ledger.balanceAfter, 5);
  assert.equal(ledger.referenceDocType, "SCRAP_ORDER");
  assert.equal(ledger.referenceDocId, ORDER);
  assert.equal(ledger.totalCostValue.toFixed(2), "30.00");

  assert.equal(call("lotItemUpdate")[1].data.status, "SCRAPPED");
  assert.equal(call("orderUpdate")[1].data.status, "COMPLETED");
  assert.equal(call("orderUpdate")[1].data.totalLossValue.toFixed(2), "30.00");

  assert.equal(result.inventoryReduced, 3);
  assert.equal(result.lossAmount, 30);
  assert.equal(result.lotScrapped, true);
  assert.equal(result.ledgerCreated, true);
});

test("approval keeps the quarantine when stock and quarantined units remain", async () => {
  state.lotItem = { ...state.lotItem, quarantineQty: 5 };
  state.lotStock = { _sum: { quantityOnHand: 0, damagedQuantity: 4 } };

  const result = await service.approveScrapOrder(BUSINESS, ownerActor, ORDER, { reviewedImageIds: [IMAGE_1] });

  const update = call("lotItemUpdate")[1].data;
  assert.deepEqual(update, { quarantineQty: 2 });
  assert.equal(result.lotScrapped, false);
});

test("approval clears the quarantine and recalculates the lot when nothing is left quarantined", async () => {
  state.lotItem = { ...state.lotItem, quarantineQty: null };
  state.lotStock = { _sum: { quantityOnHand: 4, damagedQuantity: 0 } };

  const result = await service.approveScrapOrder(BUSINESS, ownerActor, ORDER, { reviewedImageIds: [IMAGE_1] });

  const update = call("lotItemUpdate")[1].data;
  assert.equal(update.quarantineQty, null);
  assert.equal(update.quarantinedAt, null);
  assert.equal(update.quarantinedBy, null);
  assert.equal(update.quarantineNote, null);
  assert.ok(["HEALTHY", "WARNING", "UNUSABLE"].includes(update.status));
  assert.equal(result.lotScrapped, false);
});

test("rejection records a known reason code and only accepts a pending order", async () => {
  await rejects(() => service.rejectScrapOrder(BUSINESS, staffActor, ORDER, { reasonCode: "OTHER" }), 403);
  await rejects(() => service.rejectScrapOrder(BUSINESS, ownerActor, ORDER, { reasonCode: "NOPE" }), 400);
  await rejects(
    () => service.rejectScrapOrder(BUSINESS, ownerActor, ORDER, { reasonCode: "OTHER", note: "x".repeat(501) }),
    400,
  );
  await rejects(() => service.rejectScrapOrder(BUSINESS, ownerActor, ORDER, { reasonCode: "OTHER", note: 5 }), 400);

  state.locked = { id: ORDER, status: "COMPLETED", created_by: STAFF };
  await rejects(() => service.rejectScrapOrder(BUSINESS, ownerActor, ORDER, { reasonCode: "OTHER" }), 409);

  state.locked = { id: ORDER, status: "PENDING", created_by: STAFF };
  await service.rejectScrapOrder(BUSINESS, ownerActor, ORDER, {
    reasonCode: REJECTION_REASON_CODES[1],
    note: "  Ảnh mờ  ",
  });

  const data = call("orderUpdate")[1].data;
  assert.equal(data.status, "REJECTED");
  assert.equal(data.rejectedBy, OWNER);
  assert.equal(data.rejectionReasonCode, "PHOTO_UNCLEAR");
  assert.equal(data.rejectionNote, "Ảnh mờ");
});

test("scrap statistics count only approved orders as a loss", async () => {
  state.statusGroups = [
    { status: "PENDING", _count: { _all: 2 } },
    { status: "COMPLETED", _count: { _all: 3 } },
    { status: "REJECTED", _count: { _all: 4 } },
  ];
  state.sourceGroups = [
    { scrapSource: "DAMAGED_STOCK", _count: { _all: 5 } },
    { scrapSource: "SELLABLE_STOCK", _count: { _all: 4 } },
  ];
  state.lossAggregate = { _sum: { totalLossValue: new Prisma.Decimal("125.50") } };

  const stats = await service.getScrapStatistics(BUSINESS);

  assert.equal(stats.pendingCount, 2);
  assert.equal(stats.completedCount, 3);
  assert.equal(stats.rejectedCount, 4);
  assert.equal(stats.totalLossValue, 125.5);
  assert.deepEqual(stats.bySource, { DAMAGED_STOCK: 5, SELLABLE_STOCK: 4 });
  assert.equal(call("orderAggregate")[1].where.status, "COMPLETED");
});
