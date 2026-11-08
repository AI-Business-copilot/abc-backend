const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");
const { calculatePromotion, chooseBestPromotion } = require("../src/modules/promotions/promotion-calculator.ts");

const D = value => new Prisma.Decimal(value);
const now = new Date("2026-11-07T10:00:00.000Z");
function promotion(overrides = {}) {
  return {
    id: "promo",
    name: "Promotion",
    discountType: "PERCENTAGE",
    discountValue: D("10"),
    scope: "STORE",
    minOrderAmount: null,
    startsAt: new Date("2026-11-01T00:00:00.000Z"),
    endsAt: new Date("2026-12-01T00:00:00.000Z"),
    priority: 0,
    updatedAt: now,
    targets: [],
    ...overrides,
  };
}
const line = (variantId, productTemplateId, categoryId, quantity, unitPrice) => ({
  variantId,
  productTemplateId,
  categoryId,
  quantity,
  unitPrice: D(unitPrice),
});

test("percentage promotion allocates rounded discount by eligible line and honors category descendants", () => {
  const promo = promotion({
    scope: "CATEGORY",
    targets: [{ targetType: "CATEGORY", categoryId: "parent", productTemplateId: null }],
  });
  const result = calculatePromotion(promo, [
    line("a", "product-a", "child", 1, "10.00"),
    line("b", "product-b", "other", 1, "20.00"),
  ], D("30"), new Map([["child", new Set(["child", "parent"])], ["other", new Set(["other"])]]));

  assert.equal(result.discountAmount.toFixed(2), "1.00");
  assert.equal(result.lineDiscounts.get("a").toFixed(2), "1.00");
  assert.equal(result.lineDiscounts.has("b"), false);
});

test("fixed promotion is capped at eligible subtotal and minimum is checked against full order", () => {
  const promo = promotion({
    discountType: "FIXED_AMOUNT",
    discountValue: D("100"),
    scope: "PRODUCT",
    minOrderAmount: D("50"),
    targets: [{ targetType: "PRODUCT", categoryId: null, productTemplateId: "product-a" }],
  });
  const result = calculatePromotion(promo, [
    line("a", "product-a", null, 1, "10.00"),
    line("b", "product-b", null, 1, "50.00"),
  ], D("60"), new Map());

  assert.equal(result.discountAmount.toFixed(2), "10.00");
  assert.equal(result.lineDiscounts.get("a").toFixed(2), "10.00");
  assert.equal(result.lineDiscounts.has("b"), false);
  assert.equal(calculatePromotion(promo, [line("a", "product-a", null, 1, "10.00")], D("10"), new Map()), null);
});

test("best promotion maximizes savings then uses configured priority", () => {
  const smaller = { promotion: promotion({ id: "low", priority: 99 }), discountAmount: D("5.00") };
  const higherPriority = { promotion: promotion({ id: "priority", priority: 10 }), discountAmount: D("8.00") };
  const lowerPriority = { promotion: promotion({ id: "tie", priority: 1 }), discountAmount: D("8.00") };

  assert.equal(chooseBestPromotion([smaller, lowerPriority, higherPriority]).promotion.id, "priority");
});

test("promotion does not apply when no products qualify", () => {
  const result = calculatePromotion(promotion({
    scope: "PRODUCT",
    targets: [{ targetType: "PRODUCT", categoryId: null, productTemplateId: "other" }],
  }), [line("a", "product-a", null, 1, "10.00")], D("10"), new Map());
  assert.equal(result, null);
});
