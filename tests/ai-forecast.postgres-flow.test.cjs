require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../src/shared/infrastructure/database/prisma.client");
const { aiInsightsService } = require("../src/modules/ai-insights/ai-insights.service");
const { forecastHistory } = require("../src/modules/ai-forecast/forecast-history.service");
const { replenishmentService } = require("../src/modules/ai-forecast/replenishment.service");

const enabled = process.env.AI_FORECAST_ISOLATED_FLOW === "1";

test("PostgreSQL and forecast service: analysis to history and draft PO", { skip: !enabled }, async () => {
  const database = new URL(process.env.DATABASE_URL);
  assert.equal(database.protocol, "postgresql:");
  assert.equal(database.hostname, "127.0.0.1");
  assert.equal(database.pathname, "/forecast_integration");
  const forecast = new URL(process.env.FORECAST_RESEARCH_URL);
  assert.equal(forecast.protocol, "http:");
  assert.equal(forecast.hostname, "127.0.0.1");
  assert.ok(process.env.FORECAST_RESEARCH_TOKEN);
  const businessId = process.env.AI_FORECAST_TEST_BUSINESS;
  const sku = process.env.AI_FORECAST_TEST_SKU;
  const prefix = process.env.AI_FORECAST_TEST_DEMO_PREFIX;
  assert.ok(businessId && sku && prefix && sku.startsWith(prefix), "An isolated demo business and SKU are required.");
  assert.equal(await prisma.business.count(), 1, "The database must contain exactly the dedicated test business.");
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  assert.ok(business && business.status === "SUSPENDED" && business.name.startsWith("FORECAST-ISOLATED-TEST-"),
    "Refusing to analyze a business without the isolated test marker.");
  const user = await prisma.user.findFirst({
    where: { status: "ACTIVE", memberships: { some: { businessId, status: "ACTIVE" } } },
    select: { id: true, authUserId: true },
  });
  const variant = await prisma.productVariant.findFirst({ where: { businessId, sku }, select: { id: true } });
  assert.ok(user && variant, "The isolated demo fixture needs an active member and the selected SKU.");
  assert.equal(await prisma.aiInsightRun.count({ where: { businessId } }), 0, "Use a fresh isolated fixture.");
  assert.equal(await prisma.purchaseOrder.count({ where: { businessId, status: "DRAFT" } }), 0);

  const analysis = await aiInsightsService.run(businessId, "MANUAL", user.id);
  assert.equal(analysis.forecastStatus, "READY");
  const latest = await prisma.aiForecast.findUnique({ where: { businessId_variantId: { businessId, variantId: variant.id } } });
  assert.ok(latest && latest.status === "OK" && latest.runId === analysis.runId);
  const history = await forecastHistory(businessId, variant.id);
  const item = history.items.find((row) => row.runId === analysis.runId);
  assert.ok(item);
  assert.equal(item.nextDayEvaluation.status, "OK");
  assert.deepEqual(item.nextDayEvaluation.evaluations.map((row) => row.status), Array(3).fill("PENDING"));

  const suggestion = await prisma.aiReplenishmentItem.findFirst({
    where: { businessId, runId: analysis.runId, status: "PENDING", supplierId: { not: null } },
    orderBy: { id: "asc" },
  });
  assert.ok(suggestion, "The isolated fixture must produce a supplier-backed suggestion.");
  const result = await replenishmentService.createDraftOrders(businessId, user.authUserId, user.id, {
    items: [{ id: suggestion.id }],
  });
  assert.equal(result.orders.length, 1);
  const order = await prisma.purchaseOrder.findUnique({ where: { id: result.orders[0].id }, include: { purchaseOrderItems: true } });
  assert.ok(order && order.businessId === businessId && order.status === "DRAFT");
  assert.equal(order.purchaseOrderItems.length, 1);
  assert.equal(order.purchaseOrderItems[0].variantId, suggestion.variantId);
  assert.equal(order.purchaseOrderItems[0].orderedQty, suggestion.suggestedQty);
  const updated = await prisma.aiReplenishmentItem.findUnique({ where: { id: suggestion.id } });
  assert.equal(updated.status, "ORDERED");
  assert.equal(updated.poId, order.id);
});

test.after(async () => { if (enabled) await prisma.$disconnect(); });
