const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");
const { refundAmountForOrderItem } = require("../src/modules/customer-returns/customer-returns.service.ts");

const D = value => new Prisma.Decimal(value);

test("partial returns refund the exact discounted line value with remainder cents assigned once", () => {
  const item = { subtotal: D("29.99"), discountAmount: D("0.01"), quantity: 3 };
  const first = refundAmountForOrderItem(item, 0, 1);
  const second = refundAmountForOrderItem(item, 1, 1);
  const last = refundAmountForOrderItem(item, 2, 1);
  const full = refundAmountForOrderItem(item, 0, 3);

  assert.equal(first.toFixed(2), "10.00");
  assert.equal(second.toFixed(2), "9.99");
  assert.equal(last.toFixed(2), "9.99");
  assert.equal(first.plus(second).plus(last).toFixed(2), "29.98");
  assert.equal(full.toFixed(2), "29.98");
});
