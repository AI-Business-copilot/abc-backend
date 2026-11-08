const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");
const { buildPosMetricRows } = require("../src/modules/business-data/business-data.service.ts");

const decimal = (value) => new Prisma.Decimal(value);

test("POS daily rows combine sales and returns without losing discounts or actual refunds", () => {
  const rows = buildPosMetricRows("business-1", [
    {
      metricDate: new Date("2026-04-20T00:00:00.000Z"),
      variantId: "variant-1",
      unitsSold: 3,
      orderCount: 2,
      grossSales: decimal("300"),
      discountAmount: decimal("30"),
      cogs: decimal("150"),
    },
  ], [
    {
      metricDate: "2026-04-20",
      variantId: "variant-1",
      unitsReturned: 1,
      refundAmount: decimal("90"),
      returnedCogs: decimal("50"),
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].unitsSold, 3);
  assert.equal(rows[0].unitsReturned, 1);
  assert.equal(rows[0].orderCount, 2);
  assert.equal(rows[0].netRevenue.toFixed(2), "180.00");
  assert.equal(rows[0].netCogs.toFixed(2), "100.00");
});

test("POS return-only days remain visible and do not invent sales or returned cost", () => {
  const rows = buildPosMetricRows("business-1", [], [
    {
      metricDate: "2026-04-21",
      variantId: "variant-2",
      unitsReturned: 1,
      refundAmount: decimal("45"),
      returnedCogs: decimal(0),
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].unitsSold, 0);
  assert.equal(rows[0].netRevenue.toFixed(2), "-45.00");
  assert.equal(rows[0].netCogs.toFixed(2), "0.00");
});
