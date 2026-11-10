const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");

const BUSINESS = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

/** Dates are built relative to today because the service reads the clock itself. */
const inDays = (days, from = new Date()) => {
  const date = new Date(from);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date;
};

/** A product_lot_items row with the balances the expiry list reads. */
const lotItemRow = (overrides = {}) => ({
  id: "item-1",
  variantId: "variant-1",
  manufacturingDate: null,
  expirationDate: inDays(30),
  status: "HEALTHY",
  quarantineQty: null,
  quarantinedAt: null,
  lot: { id: "lot-1", lotNumber: "LOT-1" },
  variant: { id: "variant-1", sku: "SKU-1", template: { name: "Sữa rửa mặt" } },
  inventoryBalances: [{ quantityOnHand: 5, damagedQuantity: 0 }],
  ...overrides,
});

let state;
let calls;

const resetState = () => {
  calls = [];
  state = {
    expiringRows: [],
    sellableRows: [],
    quarantineItem: null,
    pendingScrapOrders: 0,
    variantLock: { isLockedForAudit: false },
    balanceAgg: { _sum: { quantityOnHand: 4, damagedQuantity: 2 } },
    updatedLotItem: { id: "item-1", status: "QUARANTINED" },
    queryRows: [],
    queryError: null,
  };
};

const db = {
  productLotItem: {
    findMany: async (args) => {
      calls.push(["lotItemFindMany", args]);
      const rows = args?.where?.id ? state.sellableRows : state.expiringRows;
      // The expiry queries ask for ascending expiry, which the fake has to honour itself.
      return args?.orderBy?.expirationDate === "asc"
        ? [...rows].sort((a, b) => a.expirationDate - b.expirationDate)
        : rows;
    },
    findUnique: async (args) => {
      calls.push(["lotItemFindUnique", args]);
      return state.quarantineItem;
    },
    update: async (args) => {
      calls.push(["lotItemUpdate", args]);
      return state.updatedLotItem;
    },
  },
  inventoryBalance: {
    aggregate: async (args) => {
      calls.push(["balanceAggregate", args]);
      return state.balanceAgg;
    },
  },
  scrapOrder: {
    count: async (args) => {
      calls.push(["scrapCount", args]);
      return state.pendingScrapOrders;
    },
  },
  productVariant: {
    findFirst: async (args) => {
      calls.push(["variantFindFirst", args]);
      return state.variantLock;
    },
  },
  $queryRaw: async () => {
    calls.push(["queryRaw"]);
    if (state.queryError) throw state.queryError;
    return state.queryRows;
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

const { LotStatusService } = require("../src/modules/inventory/services/lot-status.service.ts");
const { LotService } = require("../src/modules/inventory/services/lot.service.ts");
const { updateLotStatusesCron } = require("../src/cron/update-lot-statuses.cron.ts");

const statusService = new LotStatusService();
const lotService = new LotService(statusService);

beforeEach(resetState);

const call = (name) => calls.find(([key]) => key === name);
const rejects = (fn, statusCode) =>
  assert.rejects(fn, (err) => {
    assert.equal(err.statusCode, statusCode, `expected ${statusCode}, got ${err.statusCode}: ${err.message}`);
    return true;
  });

test("lot status uses the 60 and 7 day boundaries", () => {
  const reference = new Date("2026-11-10T12:00:00");
  const at = (days) => inDays(days, reference);

  assert.equal(statusService.calculateStatus(at(61), reference), "HEALTHY");
  assert.equal(statusService.calculateStatus(at(60), reference), "WARNING");
  assert.equal(statusService.calculateStatus(at(8), reference), "WARNING");
  assert.equal(statusService.calculateStatus(at(7), reference), "UNUSABLE");
  assert.equal(statusService.calculateStatus(at(1), reference), "UNUSABLE");
  assert.equal(statusService.calculateStatus(at(0), reference), "UNUSABLE");
  assert.equal(statusService.calculateStatus(at(-5), reference), "UNUSABLE");
});

test("day counts ignore the time of day and drive the near-expiry flags", () => {
  const days = statusService.getDaysUntilExpiry(
    new Date("2026-11-20T23:30:00"),
    new Date("2026-11-10T00:15:00"),
  );
  assert.equal(days, 10);

  const reference = new Date("2026-11-10T12:00:00");
  assert.equal(statusService.isNearExpiry(inDays(60, reference), reference), true);
  assert.equal(statusService.isNearExpiry(inDays(61, reference), reference), false);
  assert.equal(statusService.isNearExpiry(inDays(7, reference), reference), false);
  assert.equal(statusService.isUnusable(inDays(7, reference), reference), true);
  assert.equal(statusService.isUnusable(inDays(8, reference), reference), false);
  assert.equal(statusService.isExpired(inDays(0, reference), reference), true);
});

test("stored quarantine and scrap decisions win over the expiry date", () => {
  const past = inDays(-30);
  assert.equal(statusService.getEffectiveStatus("QUARANTINED", past), "QUARANTINED");
  assert.equal(statusService.getEffectiveStatus("SCRAPPED", past), "SCRAPPED");
  assert.equal(statusService.getEffectiveStatus("UNUSABLE", inDays(365)), "UNUSABLE");
  assert.equal(statusService.getEffectiveStatus("HEALTHY", inDays(10)), "WARNING");
  assert.equal(statusService.getEffectiveStatus("WARNING", inDays(90)), "HEALTHY");
});

test("status colours separate sellable, watch and blocked lots", () => {
  assert.equal(statusService.getStatusColor("HEALTHY"), "green");
  assert.equal(statusService.getStatusColor("WARNING"), "yellow");
  assert.equal(statusService.getStatusColor("UNUSABLE"), "red");
  assert.equal(statusService.getStatusColor("SCRAPPED"), "red");
  assert.equal(statusService.getStatusColor("QUARANTINED"), "gray");
});

test("a lot can only be sold while it is healthy or in the warning window", () => {
  assert.deepEqual(lotService.canSellFromLot("SCRAPPED", inDays(30)), {
    allowed: false,
    reason: "Lot has been scrapped",
  });
  assert.deepEqual(lotService.canSellFromLot("QUARANTINED", inDays(30)), {
    allowed: false,
    reason: "Lot is in quarantine",
  });
  assert.deepEqual(lotService.canSellFromLot("HEALTHY", inDays(3)), {
    allowed: false,
    reason: "Lot is expired or near expiry",
  });
  assert.deepEqual(lotService.canSellFromLot("HEALTHY", inDays(30)), { allowed: true });
  assert.deepEqual(lotService.canSellFromLot("WARNING", inDays(45)), { allowed: true });
});

test("the POS check names every blocked lot and rejects unknown ids", async () => {
  await lotService.assertLotItemsSellable(BUSINESS, []);
  assert.equal(calls.some(([key]) => key === "lotItemFindMany"), false, "an empty cart needs no lookup");

  state.sellableRows = [];
  await rejects(() => lotService.assertLotItemsSellable(BUSINESS, ["missing"]), 404);

  state.sellableRows = [
    {
      id: "item-1",
      status: "QUARANTINED",
      expirationDate: inDays(30),
      lot: { lotNumber: "LOT-1" },
      variant: { sku: "SKU-1" },
    },
    {
      id: "item-2",
      status: "HEALTHY",
      expirationDate: new Date("2000-01-01"),
      lot: { lotNumber: "LOT-2" },
      variant: { sku: "SKU-2" },
    },
  ];
  await assert.rejects(lotService.assertLotItemsSellable(BUSINESS, ["item-1", "item-2"]), (err) => {
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /LOT-1 \/ SKU-1/);
    assert.match(err.message, /LOT-2 \/ SKU-2/);
    return true;
  });

  state.sellableRows = [
    {
      id: "item-3",
      status: "HEALTHY",
      expirationDate: inDays(120),
      lot: { lotNumber: "LOT-3" },
      variant: { sku: "SKU-3" },
    },
  ];
  await lotService.assertLotItemsSellable(BUSINESS, ["item-3"]);
});

test("the expiry list shows warning, unusable and quarantined items by default", async () => {
  state.expiringRows = [
    lotItemRow({ id: "healthy", expirationDate: inDays(90) }),
    lotItemRow({ id: "warning", expirationDate: inDays(30) }),
    lotItemRow({ id: "unusable", expirationDate: inDays(3) }),
    lotItemRow({ id: "quarantined", status: "QUARANTINED", expirationDate: inDays(120) }),
    lotItemRow({ id: "scrapped", status: "SCRAPPED", expirationDate: inDays(120) }),
  ];

  const result = await lotService.getExpiringLots(BUSINESS);

  assert.deepEqual(result.lots.map((item) => item.id), ["unusable", "warning", "quarantined"]);
  assert.equal(result.total, 3);
  assert.equal(result.summary.healthy, 1);
  assert.equal(result.summary.warning, 1);
  assert.equal(result.summary.unusable, 1);
  assert.equal(result.summary.quarantined, 1);
  assert.equal(result.summary.scrapped, 1);
  assert.equal(result.summary.total, 3);

  const where = call("lotItemFindMany")[1].where;
  assert.equal(where.variant.template.hasLotTracking, true, "apparel without expiry dates is not listed");

  await rejects(() => lotService.getExpiringLots(BUSINESS, { status: "EXPIRED" }), 400);
});

test("the expiry list can group the variants of one batch and page over batches", async () => {
  state.expiringRows = [
    lotItemRow({ id: "c", variantId: "variant-c", expirationDate: inDays(5), lot: { id: "lot-2", lotNumber: "LOT-2" } }),
    lotItemRow({ id: "b", variantId: "variant-b", expirationDate: inDays(10) }),
    lotItemRow({ id: "a", variantId: "variant-a", expirationDate: inDays(20) }),
  ];

  const first = await lotService.getExpiringLots(BUSINESS, { groupBy: "lot", take: 1, skip: 0 });
  assert.equal(first.total, 2);
  assert.equal(first.lots.length, 1);
  assert.equal(first.lots[0].lotNumber, "LOT-2");
  assert.deepEqual(first.lots[0].items.map((item) => item.id), ["c"]);

  const second = await lotService.getExpiringLots(BUSINESS, { groupBy: "lot", take: 1, skip: 1 });
  assert.equal(second.lots[0].lotNumber, "LOT-1");
  assert.deepEqual(second.lots[0].items.map((item) => item.id), ["b", "a"]);
});

test("quarantine needs a whole positive quantity within the available stock", async () => {
  await rejects(() => lotService.quarantineLot(BUSINESS, "item-1", USER, { quantity: 0 }), 400);
  await rejects(() => lotService.quarantineLot(BUSINESS, "item-1", USER, { quantity: 1.5 }), 400);
  await rejects(
    () => lotService.quarantineLot(BUSINESS, "item-1", USER, { quantity: 1, note: "x".repeat(501) }),
    400,
  );

  state.quarantineItem = null;
  await rejects(() => lotService.quarantineLot(BUSINESS, "item-1", USER, { quantity: 1 }), 404);

  state.quarantineItem = { id: "item-1", businessId: BUSINESS, status: "SCRAPPED" };
  await rejects(() => lotService.quarantineLot(BUSINESS, "item-1", USER, { quantity: 1 }), 409);

  state.quarantineItem = { id: "item-1", businessId: BUSINESS, status: "WARNING" };
  state.pendingScrapOrders = 1;
  await rejects(() => lotService.quarantineLot(BUSINESS, "item-1", USER, { quantity: 1 }), 409);

  state.pendingScrapOrders = 0;
  state.variantLock = { isLockedForAudit: true };
  await rejects(() => lotService.quarantineLot(BUSINESS, "item-1", USER, { quantity: 1 }), 409);

  state.variantLock = { isLockedForAudit: false };
  await rejects(() => lotService.quarantineLot(BUSINESS, "item-1", USER, { quantity: 7 }), 409);

  state.updatedLotItem = { id: "item-1", status: "QUARANTINED", quarantineQty: 3 };
  const result = await lotService.quarantineLot(BUSINESS, "item-1", USER, {
    quantity: 3,
    note: "  Hết hạn  ",
  });

  const data = call("lotItemUpdate")[1].data;
  assert.equal(data.status, "QUARANTINED");
  assert.equal(data.quarantineQty, 3);
  assert.equal(data.quarantinedBy, USER);
  assert.equal(data.quarantineNote, "Hết hạn");
  assert.ok(data.quarantinedAt instanceof Date);
  assert.equal(result.status, "QUARANTINED");
});

test("the nightly status job reports transitions and never throws", async () => {
  state.queryRows = [
    { from_status: "HEALTHY", to_status: "WARNING", count: 2 },
    { from_status: "WARNING", to_status: "UNUSABLE", count: 1 },
  ];
  const ok = await updateLotStatusesCron();
  assert.equal(ok.success, true);
  assert.equal(ok.updatedCount, 3);
  assert.deepEqual(ok.transitions, [
    { from: "HEALTHY", to: "WARNING", count: 2 },
    { from: "WARNING", to: "UNUSABLE", count: 1 },
  ]);

  state.queryError = new Error("database is down");
  const failed = await updateLotStatusesCron();
  assert.equal(failed.success, false);
  assert.equal(failed.error, "database is down");
});
