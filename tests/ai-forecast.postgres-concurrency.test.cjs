require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { prisma } = require("../src/shared/infrastructure/database/prisma.client");
const { businessToday, addDays } = require("../src/modules/ai-insights/snapshot/build-snapshot");
const { replenishmentService } = require("../src/modules/ai-forecast/replenishment.service");

const sourceBusiness = process.env.AI_FORECAST_TEST_BUSINESS;
const enabled = Boolean(sourceBusiness && process.env.AI_FORECAST_CREATE_TEMP_BUSINESS === "1");

test("PostgreSQL: atomic multi-supplier rollback and concurrent duplicate requests", { skip: !enabled }, async () => {
  const user = await prisma.user.findFirst({
    where: { status: "ACTIVE", memberships: { some: { businessId: sourceBusiness } } },
    select: { id: true, authUserId: true },
  });
  assert.ok(user, "The selected business needs an active user.");
  const id = randomUUID();
  const name = `FORECAST-TEST-${id}`;
  const today = await businessToday();
  const asOf = new Date(`${addDays(today, -1)}T00:00:00Z`);
  const ids = [];
  try {
    await prisma.$transaction(async (tx) => {
      await tx.business.create({ data: { id, name, phone: "0000000000", industryType: "TEST", status: "SUSPENDED" } });
      const run = await tx.aiInsightRun.create({
        data: { businessId: id, triggerType: "MANUAL", status: "SUCCEEDED", dataAsOf: asOf, summary: { forecastStatus: "READY" } },
      });
      for (let i = 0; i < 2; i++) {
        const template = await tx.productTemplate.create({ data: { businessId: id, name: `Test ${i}` } });
        const variant = await tx.productVariant.create({ data: { businessId: id, templateId: template.id, sku: `TEST-${i}`, basePrice: 20, costPrice: 10 } });
        const supplier = await tx.supplier.create({ data: { businessId: id, name: `Supplier ${i}`, supplierCode: `TEST-${i}` } });
        await tx.supplierProduct.create({ data: { businessId: id, supplierId: supplier.id, variantId: variant.id, supplyPrice: 10, minOrderQty: 6, orderMultiple: 6 } });
        const suggestion = await tx.aiReplenishmentItem.create({
          data: { businessId: id, variantId: variant.id, runId: run.id, supplierId: supplier.id, status: "PENDING", urgency: "HIGH",
            suggestedQty: 6, unitCost: 10, amount: 60, details: { leadTimeDays: 3 } },
        });
        ids.push(suggestion.id);
        if (i === 0) await tx.aiForecast.create({
          data: { businessId: id, variantId: variant.id, runId: run.id, asOf, status: "OK", model: "MEAN_28", dailyRate: 1, result: {} },
        });
      }
    }, { timeout: 60_000 });

    await assert.rejects(
      replenishmentService.createDraftOrders(id, user.authUserId, user.id, { items: [{ id: ids[0] }, { id: ids[1], qty: 1 }] }),
      /tối thiểu/,
    );
    assert.equal(await prisma.purchaseOrder.count({ where: { businessId: id } }), 0);
    assert.equal(await prisma.aiReplenishmentItem.count({ where: { businessId: id, status: "PENDING" } }), 2);

    const request = () => replenishmentService.createDraftOrders(id, user.authUserId, user.id, { items: [{ id: ids[0] }] });
    const results = await Promise.allSettled([request(), request()]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failure = results.find((result) => result.status === "rejected");
    assert.equal(failure.reason.statusCode, 409);
    assert.equal(await prisma.purchaseOrder.count({ where: { businessId: id } }), 1);
  } finally {
    const business = await prisma.business.findUnique({ where: { id }, select: { name: true } });
    if (business) {
      assert.equal(business.name, name, "Refusing to clean up an unexpected business.");
      await prisma.$transaction(async (tx) => {
        await tx.aiReplenishmentItem.deleteMany({ where: { businessId: id } });
        await tx.purchaseOrder.deleteMany({ where: { businessId: id } });
        await tx.aiForecast.deleteMany({ where: { businessId: id } });
        await tx.aiInsightRun.deleteMany({ where: { businessId: id } });
        await tx.supplierProduct.deleteMany({ where: { businessId: id } });
        await tx.supplier.deleteMany({ where: { businessId: id } });
        await tx.productVariant.deleteMany({ where: { businessId: id } });
        await tx.productTemplate.deleteMany({ where: { businessId: id } });
        await tx.business.delete({ where: { id } });
      }, { timeout: 60_000 });
    }
    await prisma.$disconnect();
  }
});
