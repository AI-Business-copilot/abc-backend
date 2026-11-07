import { Prisma } from "@prisma/client";

export interface PromotionCartLine {
  variantId: string;
  productTemplateId: string;
  categoryId: string | null;
  quantity: number;
  unitPrice: Prisma.Decimal;
}

export interface PromotionCalculation {
  promotion: {
    id: string;
    name: string;
    discountType: string;
    discountValue: Prisma.Decimal;
    scope: string;
    minOrderAmount: Prisma.Decimal | null;
    startsAt: Date;
    endsAt: Date;
    priority: number;
    updatedAt: Date;
    targets: { targetType: string; categoryId: string | null; productTemplateId: string | null }[];
  };
  discountAmount: Prisma.Decimal;
  lineDiscounts: Map<string, Prisma.Decimal>;
}

export function calculatePromotion(
  promotion: PromotionCalculation["promotion"],
  cartLines: PromotionCartLine[],
  orderTotal: Prisma.Decimal,
  categoryAncestors: Map<string, Set<string>>,
): PromotionCalculation | null {
  if (promotion.minOrderAmount && orderTotal.lt(promotion.minOrderAmount)) return null;

  const productIds = new Set(
    promotion.targets.filter(target => target.targetType === "PRODUCT").map(target => target.productTemplateId),
  );
  const targetCategoryIds = new Set(
    promotion.targets
      .filter(target => target.targetType === "CATEGORY")
      .map(target => target.categoryId)
      .filter((id): id is string => id !== null),
  );
  const eligible = cartLines.filter(line => {
    if (promotion.scope === "STORE") return true;
    if (promotion.scope === "PRODUCT") return productIds.has(line.productTemplateId);
    if (promotion.scope === "CATEGORY" && line.categoryId) {
      return [...(categoryAncestors.get(line.categoryId) ?? [])].some(id => targetCategoryIds.has(id));
    }
    return false;
  });
  if (!eligible.length) return null;

  const eligibleTotal = eligible.reduce(
    (total, line) => total.plus(line.unitPrice.mul(line.quantity)),
    new Prisma.Decimal(0),
  );
  if (eligibleTotal.isZero()) return null;

  const requestedDiscount = promotion.discountType === "PERCENTAGE"
    ? eligibleTotal.mul(promotion.discountValue).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    : promotion.discountValue;
  const discountAmount = Prisma.Decimal.min(requestedDiscount, eligibleTotal);
  if (discountAmount.isZero()) return null;

  const lineDiscounts = new Map<string, Prisma.Decimal>();
  let remaining = discountAmount;
  eligible.forEach((line, index) => {
    const gross = line.unitPrice.mul(line.quantity);
    const allocated = index === eligible.length - 1
      ? remaining
      : Prisma.Decimal.min(
          remaining,
          discountAmount.mul(gross).div(eligibleTotal).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        );
    lineDiscounts.set(line.variantId, allocated);
    remaining = remaining.minus(allocated);
  });

  return { promotion, discountAmount, lineDiscounts };
}

export function chooseBestPromotion(calculations: PromotionCalculation[]): PromotionCalculation | null {
  return calculations.sort((a, b) => {
    const discountOrder = b.discountAmount.comparedTo(a.discountAmount);
    if (discountOrder) return discountOrder;
    if (a.promotion.priority !== b.promotion.priority) return b.promotion.priority - a.promotion.priority;
    return a.promotion.id.localeCompare(b.promotion.id);
  })[0] ?? null;
}
