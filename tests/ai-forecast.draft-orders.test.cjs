require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { Prisma } = require("@prisma/client");
// Mock the database boundary so unit tests do not depend on generated delegates or credentials.
const prisma = { aiInsightRun: {}, aiForecast: {}, aiReplenishmentItem: {}, $transaction: undefined };
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma } };
const snapshot = require("../src/modules/ai-insights/snapshot/build-snapshot");
const { purchasesWriteService } = require("../src/modules/purchases/purchases-write.service");
const { replenishmentService } = require("../src/modules/ai-forecast/replenishment.service");

function setup(t, options = {}) {
  const run = { id: "run", status: "SUCCEEDED", dataAsOf: new Date("2025-01-28"), summary: { forecastStatus: "READY" } };
  const state = {
    items: ["a", "b"].map((id) => ({
      id, variantId: id, runId: "run", status: "PENDING", supplierId: id,
      suggestedQty: 6, unitCost: new Prisma.Decimal(10), details: { leadTimeDays: 3 }, variant: { sku: id },
    })),
    orders: [],
  };
  t.mock.method(snapshot, "businessToday", async () => "2025-01-29");
  const runs = prisma.aiInsightRun;
  const forecasts = prisma.aiForecast;
  const previous = [runs.findFirst, forecasts.findFirst, prisma.$transaction];
  runs.findFirst = async () => run;
  forecasts.findFirst = async () => ({ asOf: run.dataAsOf });
  t.after(() => { [runs.findFirst, forecasts.findFirst, prisma.$transaction] = previous; });
  let queue = Promise.resolve();
  prisma.$transaction = (fn) => {
    const result = queue.then(async () => {
      const local = { items: state.items.map((row) => ({ ...row })), orders: [...state.orders] };
      const tx = {
        $queryRaw: async () => [],
        aiInsightRun: { findFirst: async () => options.stale ? { ...run, id: "new" } : run },
        aiReplenishmentItem: {
          findMany: async ({ where }) => local.items.filter((row) => where.id.in.includes(row.id) && row.status === where.status),
          updateMany: async ({ where, data }) => {
            const matches = local.items.filter((row) => where.id.in.includes(row.id) && row.status === where.status && row.runId === where.runId);
            matches.forEach((row) => Object.assign(row, data));
            return { count: matches.length };
          },
        },
        supplierProduct: { findFirst: async ({ where }) => ({
          supplyPrice: new Prisma.Decimal(options.changedPrice && where.supplierId === "b" ? 11 : 10),
          leadTimeDays: 3,
        }) },
        local,
      };
      const value = await fn(tx);
      state.items = local.items;
      state.orders = local.orders;
      return value;
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  t.mock.method(purchasesWriteService, "createOrderInTransaction", async (tx, business, user, body) => {
    if (options.failSecond && body.supplierId === "b") throw new Error("supplier failure");
    const order = { id: `po-${body.supplierId}`, poCode: body.poCode };
    tx.local.orders.push(order);
    return order;
  });
  return state;
}

const request = { items: [{ id: "a" }, { id: "b" }] };
const create = () => replenishmentService.createDraftOrders("business", "auth", "user", request);

test("multiple supplier drafts commit together and repeat request cannot duplicate them", async (t) => {
  const state = setup(t);
  const [first, second] = await Promise.allSettled([create(), create()]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.statusCode, 409);
  assert.equal(state.orders.length, 2);
  assert.deepEqual(state.items.map((item) => item.status), ["ORDERED", "ORDERED"]);
});

test("failure in the second supplier group rolls back the first draft", async (t) => {
  const state = setup(t, { failSecond: true });
  await assert.rejects(create(), /supplier failure/);
  assert.equal(state.orders.length, 0);
  assert.deepEqual(state.items.map((item) => item.status), ["PENDING", "PENDING"]);
});

test("changed forecast or supplier price rejects the whole request", async (t) => {
  const state = setup(t, { changedPrice: true });
  await assert.rejects(create(), /Giá nhập/);
  assert.equal(state.orders.length, 0);
});

test("changed forecast rejects before creating drafts", async (t) => {
  const state = setup(t, { stale: true });
  await assert.rejects(create(), /Dự báo đã thay đổi/);
  assert.equal(state.orders.length, 0);
});
