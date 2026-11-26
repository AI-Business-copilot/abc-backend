require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { prisma } = require("../src/shared/infrastructure/database/prisma.client");
const { addDays, businessToday, incomingSupplyRows } = require("../src/modules/ai-insights/snapshot/build-snapshot");
const { forecastHistoryInTransaction } = require("../src/modules/ai-forecast/forecast-history.service");

const businessId = process.env.AI_FORECAST_TEST_BUSINESS;
const sku = process.env.AI_FORECAST_TEST_SKU;
const enabled = Boolean(businessId && sku);
const demoPrefix = process.env.AI_FORECAST_TEST_DEMO_PREFIX;
const rollback = new Error("ROLLBACK_FORECAST_INTEGRATION_TEST");

async function fixture() {
  const variant = await prisma.productVariant.findFirst({ where: { businessId, sku }, select: { id: true } });
  assert.ok(variant, "The selected test variant must exist in the selected business.");
  return variant;
}

test("PostgreSQL: compare all forecast horizons against seeded POS and roll back", { skip: !enabled }, async () => {
  const variant = await fixture();
  const today = await businessToday();
  const asOf = addDays(today, -30);
  const id = randomUUID();
  await assert.rejects(prisma.$transaction(async (tx) => {
    const run = await tx.aiInsightRun.create({
      data: { businessId, triggerType: "MANUAL", status: "SUCCEEDED", dataAsOf: new Date(`${asOf}T00:00:00Z`),
        finishedAt: new Date(`${addDays(asOf, 1)}T03:01:00Z`) },
    });
    await tx.aiForecastHistory.create({
      data: {
        id, businessId, variantId: variant.id, runId: run.id, asOf: new Date(`${asOf}T00:00:00Z`),
        issuedAt: new Date(`${addDays(asOf, 1)}T03:00:00Z`),
        result: { status: "OK", model: "MEAN_28", modelVersion: "integration-test", totals: { d7: 7, d14: 14, d28: 28 },
          nextDayForecast: { status: "OK", policy: "next-day-v1", totals: { d7: 8, d14: 15, d28: 29 } } },
      },
    });
    const history = await forecastHistoryInTransaction(tx, businessId, variant.id, today);
    const item = history.items.find((row) => row.id === id);
    assert.ok(item);
    assert.equal(item.nextDayEvaluation.status, "OK");
    for (const evaluation of [...item.evaluations, ...item.segmentEvaluations, ...item.nextDayEvaluation.evaluations]) {
      const actual = await tx.$queryRaw`
        SELECT COALESCE(SUM(i.quantity), 0)::int AS units
        FROM orders o JOIN order_items i ON i.order_id = o.id
        WHERE o.business_id = ${businessId}::uuid AND i.variant_id = ${variant.id}::uuid AND o.status = 'COMPLETED'
          AND (o.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN ${evaluation.start}::date AND ${evaluation.end}::date
      `;
      assert.equal(evaluation.actual, actual[0].units);
      assert.equal(evaluation.partialStart, evaluation.start === addDays(asOf, 1));
    }
    await tx.aiInsightRun.update({ where: { id: run.id }, data: { status: "FAILED" } });
    assert.ok(!(await forecastHistoryInTransaction(tx, businessId, variant.id, today)).items.some((row) => row.id === id));
    throw rollback;
  }, { timeout: 60_000 }), (error) => error === rollback);
  assert.equal(await prisma.aiForecastHistory.count({ where: { id } }), 0);
});

test("PostgreSQL: history distinguishes publication, stockout, unknown stock and pending windows", { skip: !enabled }, async () => {
  const today = await businessToday();
  const asOf = addDays(today, -30);
  const id = randomUUID();
  const variantId = randomUUID();
  await assert.rejects(prisma.$transaction(async (tx) => {
    const template = await tx.productTemplate.create({
      data: { businessId, name: `Forecast test ${id}` },
    });
    await tx.productVariant.create({
      data: { id: variantId, businessId, templateId: template.id, sku: `TEST-${id}`, basePrice: 1, costPrice: 1 },
    });
    const balance = await tx.inventoryBalance.create({ data: { businessId, variantId, quantityOnHand: 10 } });
    await tx.inventoryLedger.create({
      data: { businessId, variantId, transactionType: "OPENING_STOCK", quantityChanged: 10, balanceAfter: 10,
        unitCost: 1, totalCostValue: 10, referenceDocType: "TEST", referenceDocId: randomUUID(),
        createdAt: new Date(`${addDays(asOf, -1)}T05:00:00Z`) },
    });
    const finishedAt = new Date(`${addDays(asOf, 1)}T03:01:00Z`);
    const run = await tx.aiInsightRun.create({
      data: { businessId, triggerType: "MANUAL", status: "SUCCEEDED", dataAsOf: new Date(`${asOf}T00:00:00Z`), finishedAt },
    });
    await tx.aiForecastHistory.create({
      data: { id, businessId, variantId, runId: run.id, asOf: new Date(`${asOf}T00:00:00Z`),
        issuedAt: new Date(`${addDays(asOf, 1)}T03:00:00Z`),
        result: { status: "OK", totals: { d7: 7, d14: 14, d28: 28 },
          nextDayForecast: { status: "OK", policy: "next-day-v1", totals: { d7: 8, d14: 15, d28: 29 } } } },
    });
    const get = async (date) => {
      const item = (await forecastHistoryInTransaction(tx, businessId, variantId, date)).items.find((row) => row.id === id);
      assert.ok(item);
      return item;
    };
    const clean = await get(today);
    assert.deepEqual(clean.evaluations.map((row) => row.status), Array(3).fill("PARTIAL_START"));
    assert.deepEqual(clean.nextDayEvaluation.evaluations.map((row) => row.status), Array(3).fill("COMPARABLE"));
    assert.deepEqual(clean.nextDayEvaluation.evaluations.map((row) => row.actual), [0, 0, 0]);
    const incomplete = await get(addDays(asOf, 10));
    assert.deepEqual(incomplete.nextDayEvaluation.evaluations.map((row) => row.status), ["COMPARABLE", "PENDING", "PENDING"]);

    await tx.aiInsightRun.update({ where: { id: run.id }, data: { finishedAt: null } });
    const unpublished = await get(today);
    assert.deepEqual(unpublished.nextDayEvaluation.evaluations.map((row) => row.status), Array(3).fill("PUBLICATION_UNKNOWN"));
    await tx.aiInsightRun.update({ where: { id: run.id }, data: { finishedAt } });

    await tx.inventoryLedger.create({
      data: { businessId, variantId, transactionType: "STOCK_ADJUSTMENT_OUT", quantityChanged: -10, balanceAfter: 0,
        unitCost: 1, totalCostValue: 10, referenceDocType: "TEST", referenceDocId: randomUUID(),
        createdAt: new Date(`${addDays(asOf, 8)}T05:00:00Z`) },
    });
    await tx.inventoryBalance.update({ where: { id: balance.id }, data: { quantityOnHand: 0 } });
    const stockout = await get(today);
    assert.deepEqual(stockout.evaluations.map((row) => row.status), ["PARTIAL_START", "STOCKOUT", "STOCKOUT"]);
    assert.deepEqual(stockout.nextDayEvaluation.evaluations.map((row) => row.status), Array(3).fill("STOCKOUT"));
    await tx.inventoryBalance.update({ where: { id: balance.id }, data: { quantityOnHand: 1 } });
    const unknown = await get(today);
    assert.deepEqual(unknown.nextDayEvaluation.evaluations.map((row) => row.status), Array(3).fill("UNKNOWN_STOCK"));
    throw rollback;
  }, { timeout: 60_000 }), (error) => error === rollback);
  assert.equal(await prisma.productVariant.count({ where: { id: variantId } }), 0);
});

test("PostgreSQL: include only outstanding open POs and roll back", { skip: !enabled }, async () => {
  const variant = await fixture();
  const supplier = await prisma.supplier.findFirst({ where: { businessId }, select: { id: true } });
  const shift = await prisma.cashShift.findFirst({ where: { businessId }, select: { userId: true } });
  assert.ok(supplier && shift, "Test business needs a supplier and cashier.");
  const key = `TEST-${randomUUID().slice(0, 12)}`;
  const today = await businessToday();
  await assert.rejects(prisma.$transaction(async (tx) => {
    for (const [status, receivedQty] of [["ORDERED", 0], ["PARTIALLY_RECEIVED", 4], ["CANCELLED", 0], ["DRAFT", 0], ["COMPLETED", 10]]) {
      await tx.purchaseOrder.create({
        data: {
          businessId, poCode: `${key}-${status}`, supplierId: supplier.id, createdBy: shift.userId,
          orderDate: new Date(`${addDays(today, -3)}T00:00:00Z`),
          expectedDeliveryDate: new Date(`${addDays(today, -1)}T00:00:00Z`), status,
          purchaseOrderItems: { create: [{ variantId: variant.id, orderedQty: 10, receivedQty, unitPrice: 1 }] },
        },
      });
    }
    const rows = (await incomingSupplyRows(tx, businessId)).filter((row) => row.poCode.startsWith(key));
    assert.deepEqual(rows.map((row) => row.qty).sort((a, b) => a - b), [6, 10]);
    throw rollback;
  }, { timeout: 60_000 }), (error) => error === rollback);
  assert.equal(await prisma.purchaseOrder.count({ where: { businessId, poCode: { startsWith: key } } }), 0);
});

test("PostgreSQL: saved forecasts reject updates and roll back", { skip: !enabled }, async () => {
  const variant = await fixture();
  const id = randomUUID();
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.aiForecastHistory.create({
      data: { id, businessId, variantId: variant.id, runId: randomUUID(), asOf: new Date("2026-01-01T00:00:00Z"),
        result: { status: "OK", totals: { d7: 7, d14: 14, d28: 28 } } },
    });
    await tx.aiForecastHistory.update({ where: { id }, data: { result: {} } });
  }), /Forecast history snapshots cannot be updated/);
  assert.equal(await prisma.aiForecastHistory.count({ where: { id } }), 0);
});

test("PostgreSQL: seeded movements have matching documents and stock ledger", { skip: !enabled || !demoPrefix }, async () => {
  const variant = await fixture();
  const rows = await prisma.$queryRaw`
    SELECT il.transaction_type::text AS type, il.quantity_changed AS qty,
      CASE il.transaction_type::text
        WHEN 'PURCHASE_RECEIPT' THEN EXISTS (
          SELECT 1 FROM purchase_receipts r JOIN purchase_receipt_items i ON i.receipt_id = r.id
          JOIN purchase_orders p ON p.id = r.po_id
          WHERE r.id = il.reference_doc_id AND r.business_id = ${businessId}::uuid
            AND r.receipt_code = ${`${demoPrefix}RECEIPT-1`} AND p.status = 'COMPLETED'
            AND i.variant_id = il.variant_id AND i.received_qty = il.quantity_changed)
        WHEN 'CUSTOMER_RETURN' THEN EXISTS (
          SELECT 1 FROM customer_returns r JOIN customer_return_items i ON i.return_id = r.id
          JOIN order_items oi ON oi.id = i.order_item_id
          WHERE r.id = il.reference_doc_id AND r.business_id = ${businessId}::uuid
            AND r.return_code = ${`${demoPrefix}RETURN-1`} AND i.variant_id = il.variant_id
            AND oi.variant_id = i.variant_id AND i.return_qty = il.quantity_changed)
        WHEN 'STOCK_ADJUSTMENT_OUT' THEN EXISTS (
          SELECT 1 FROM stock_audits a JOIN stock_audit_items i ON i.audit_id = a.id
          WHERE a.id = il.reference_doc_id AND a.business_id = ${businessId}::uuid
            AND a.audit_code = ${`${demoPrefix}AUDIT-1`} AND i.variant_id = il.variant_id
            AND i.counted_qty - i.snapshot_qty = il.quantity_changed)
        WHEN 'SCRAP_DISPOSAL' THEN EXISTS (
          SELECT 1 FROM scrap_orders s WHERE s.id = il.reference_doc_id AND s.business_id = ${businessId}::uuid
            AND s.scrap_code = ${`${demoPrefix}SCRAP-1`} AND s.variant_id = il.variant_id AND -s.scrap_qty = il.quantity_changed)
        ELSE false
      END AS matches
    FROM inventory_ledger il
    WHERE il.business_id = ${businessId}::uuid AND il.variant_id = ${variant.id}::uuid
      AND il.transaction_type::text IN ('PURCHASE_RECEIPT', 'CUSTOMER_RETURN', 'STOCK_ADJUSTMENT_OUT', 'SCRAP_DISPOSAL')
  `;
  assert.deepEqual(rows.map((row) => [row.type, row.qty, row.matches]).sort(), [
    ["CUSTOMER_RETURN", 1, true], ["PURCHASE_RECEIPT", 6, true],
    ["SCRAP_DISPOSAL", -1, true], ["STOCK_ADJUSTMENT_OUT", -1, true],
  ]);
  const [ledger, stock] = await Promise.all([
    prisma.inventoryLedger.aggregate({ where: { businessId, variantId: variant.id }, _sum: { quantityChanged: true } }),
    prisma.inventoryBalance.aggregate({ where: { businessId, variantId: variant.id }, _sum: { quantityOnHand: true } }),
  ]);
  assert.equal(ledger._sum.quantityChanged, stock._sum.quantityOnHand);
});

test.after(async () => { if (enabled) await prisma.$disconnect(); });
