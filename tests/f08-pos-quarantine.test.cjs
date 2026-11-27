// F08: quarantined goods must not be sold at the checkout.
//
// Quarantining a lot item does not lower the inventory balance, so the balance alone still shows
// the goods as sellable. The lot status is what keeps them off the shelf.

const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");

const BUSINESS = "22222222-2222-4222-8222-222222222222";
const VARIANT = "33333333-3333-4333-8333-333333333333";

const D = (value) => new Prisma.Decimal(value);

let state;
let calls;

const resetState = () => {
  calls = [];
  state = {
    variant: {
      id: VARIANT,
      sku: "SKU-1",
      isActive: true,
      isLockedForAudit: false,
      basePrice: D("50"),
      costPrice: D("20"),
      template: { id: "tpl-1", name: "Sữa rửa mặt", categoryId: null, hasLotTracking: true },
    },
    balances: [
      {
        id: "balance-lot-1",
        lotItemId: "lot-item-1",
        quantityOnHand: 10,
        damagedQuantity: 0,
        lotItem: { id: "lot-item-1", expirationDate: new Date("2027-01-01T00:00:00Z"), status: "HEALTHY" },
      },
      {
        id: "balance-lot-2",
        lotItemId: "lot-item-2",
        quantityOnHand: 5,
        damagedQuantity: 0,
        lotItem: { id: "lot-item-2", expirationDate: new Date("2026-06-01T00:00:00Z"), status: "QUARANTINED" },
      },
    ],
    variantQuarantine: null,
  };
};

const db = {
  productVariant: {
    findFirst: async (args) => {
      calls.push(["variantFindFirst", args]);
      return state.variant;
    },
  },
  inventoryBalance: {
    findMany: async (args) => {
      calls.push(["balanceFindMany", args]);
      const filter = args.where.lotItem?.is;
      if (!filter) return state.balances.filter((balance) => balance.lotItemId === null);
      // The fake honours the filter the service builds, so the test proves the filter is right.
      return state.balances.filter((balance) => {
        if (!balance.lotItem) return false;
        if (balance.lotItem.expirationDate < filter.expirationDate.gte) return false;
        if (filter.status && filter.status.not && balance.lotItem.status === filter.status.not) return false;
        return true;
      });
    },
  },
  variantQuarantine: {
    findFirst: async (args) => {
      calls.push(["variantQuarantineFindFirst", args]);
      return state.variantQuarantine;
    },
  },
};

const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { prisma: db },
};

const { allocateStock } = require("../src/modules/sales/sales.service.ts");

beforeEach(resetState);

const call = (name) => calls.find(([key]) => key === name);
const rejects = (fn, statusCode) =>
  assert.rejects(fn, (err) => {
    assert.equal(err.statusCode, statusCode, `expected ${statusCode}, got ${err.statusCode}: ${err.message}`);
    return true;
  });

test("a quarantined lot item is not sellable at the checkout", async () => {
  const result = await allocateStock(db, BUSINESS, VARIANT, 3);

  assert.equal(result.allocations.length, 1);
  assert.equal(result.allocations[0].balance.id, "balance-lot-1", "only the healthy lot is used");
  assert.equal(result.allocations[0].quantity, 3);

  // The filter the service builds is what keeps the quarantined goods out.
  const filter = call("balanceFindMany")[1].where.lotItem.is;
  assert.equal(filter.status.not, "QUARANTINED");
});

test("goods of a quarantined lot are not sold even when the healthy lot runs out", async () => {
  await rejects(() => allocateStock(db, BUSINESS, VARIANT, 12), 409);
});

test("a product with no lot cannot be sold while its variant is quarantined", async () => {
  state.variant.template.hasLotTracking = false;
  state.balances = [
    { id: "balance-1", lotItemId: null, quantityOnHand: 10, damagedQuantity: 0, lotItem: null },
  ];
  state.variantQuarantine = { id: "quarantine-1", variantId: VARIANT, quarantineQty: 2 };

  await rejects(() => allocateStock(db, BUSINESS, VARIANT, 1), 409);

  // Once the quarantined goods have been scrapped the SKU sells again.
  state.variantQuarantine = null;
  const result = await allocateStock(db, BUSINESS, VARIANT, 1);
  assert.equal(result.allocations.length, 1);
});
