import { Prisma } from "@prisma/client";

import { HttpError } from "../../shared/http/http-error";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { actor } from "../purchases/purchases-transaction";
import {
  calculatePromotion,
  chooseBestPromotion,
  type PromotionCalculation,
  type PromotionCartLine,
} from "./promotion-calculator";

const promotionInclude = {
  targets: { include: { category: { select: { id: true, name: true } }, productTemplate: { select: { id: true, name: true } } } },
  _count: { select: { redemptions: true } },
} as const;

type PromotionInput = {
  name: string;
  description: string | null;
  discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  discountValue: Prisma.Decimal;
  scope: "STORE" | "CATEGORY" | "PRODUCT";
  startsAt: Date;
  endsAt: Date;
  minOrderAmount: Prisma.Decimal | null;
  usageLimit: number | null;
  priority: number;
  targetIds: string[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "A JSON object is required.");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `${field} is required and must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

function parseMoney(value: unknown, field: string, optional = false): Prisma.Decimal | null {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" && typeof value !== "number") throw new HttpError(400, `${field} must be a valid amount.`);
  const raw = String(value).trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) throw new HttpError(400, `${field} must have up to 2 decimal places.`);
  return new Prisma.Decimal(raw);
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${field} is required.`);
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new HttpError(400, `${field} must be a valid date.`);
  return result;
}

function parseUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, `${field} must be a valid UUID.`);
  }
  return value;
}

function parseInput(value: unknown): PromotionInput {
  const body = object(value);
  const discountType = body.discountType;
  if (discountType !== "PERCENTAGE" && discountType !== "FIXED_AMOUNT") {
    throw new HttpError(400, "discountType must be PERCENTAGE or FIXED_AMOUNT.");
  }
  const scope = body.scope;
  if (scope !== "STORE" && scope !== "CATEGORY" && scope !== "PRODUCT") {
    throw new HttpError(400, "scope must be STORE, CATEGORY, or PRODUCT.");
  }
  const discountValue = parseMoney(body.discountValue, "discountValue")!;
  if (discountValue.lte(0) || (discountType === "PERCENTAGE" && discountValue.gt(100))) {
    throw new HttpError(400, "discountValue must be greater than 0 and a percentage cannot exceed 100.");
  }
  const startsAt = parseDate(body.startsAt, "startsAt");
  const endsAt = parseDate(body.endsAt, "endsAt");
  if (endsAt <= startsAt) throw new HttpError(400, "endsAt must be later than startsAt.");
  const minOrderAmount = parseMoney(body.minOrderAmount, "minOrderAmount", true);
  const usageLimit = body.usageLimit === undefined || body.usageLimit === null || body.usageLimit === ""
    ? null
    : Number(body.usageLimit);
  if (usageLimit !== null && (!Number.isSafeInteger(usageLimit) || usageLimit < 1)) {
    throw new HttpError(400, "usageLimit must be a positive whole number.");
  }
  const priority = body.priority === undefined ? 0 : Number(body.priority);
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 1_000_000) {
    throw new HttpError(400, "priority must be a whole number between 0 and 1000000.");
  }
  const rawTargets = body.targetIds === undefined ? [] : body.targetIds;
  if (!Array.isArray(rawTargets) || rawTargets.length > 100) throw new HttpError(400, "targetIds must contain at most 100 IDs.");
  const targetIds = [...new Set(rawTargets.map((id, index) => parseUuid(id, `targetIds[${index}]`)))];
  if (scope === "STORE" && targetIds.length) throw new HttpError(400, "Store-wide promotions must not have targetIds.");
  if (scope !== "STORE" && !targetIds.length) throw new HttpError(400, "Category and product promotions require at least one target.");
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
    throw new HttpError(400, "description must be text.");
  }
  const description = typeof body.description === "string" ? body.description.trim() || null : null;
  if (description && description.length > 2000) throw new HttpError(400, "description must be at most 2000 characters.");

  return {
    name: requiredText(body.name, "name", 150),
    description,
    discountType,
    discountValue,
    scope,
    startsAt,
    endsAt,
    minOrderAmount,
    usageLimit,
    priority,
    targetIds,
  };
}

async function validateTargets(
  tx: Prisma.TransactionClient,
  businessId: string,
  scope: PromotionInput["scope"],
  targetIds: string[],
) {
  if (scope === "STORE") return;
  const found = scope === "CATEGORY"
    ? await tx.category.findMany({ where: { businessId, id: { in: targetIds } }, select: { id: true } })
    : await tx.productTemplate.findMany({ where: { businessId, id: { in: targetIds } }, select: { id: true } });
  if (found.length !== targetIds.length) throw new HttpError(400, "Every promotion target must belong to this business.");
}

function targetRows(input: PromotionInput, businessId: string) {
  return input.targetIds.map(id => ({
    businessId,
    targetType: input.scope,
    ...(input.scope === "CATEGORY" ? { categoryId: id } : { productTemplateId: id }),
  }));
}

function promotionData(input: PromotionInput) {
  const { targetIds: _targetIds, ...data } = input;
  return data;
}

function configSnapshot(calculation: PromotionCalculation) {
  const { promotion } = calculation;
  const targets = promotion.targets
    .map(target => target.targetType === "CATEGORY" ? target.categoryId : target.productTemplateId)
    .filter((id): id is string => id !== null)
    .sort();
  return {
    promotionId: promotion.id,
    name: promotion.name,
    discountType: promotion.discountType,
    discountValue: promotion.discountValue.toString(),
    scope: promotion.scope,
    minOrderAmount: promotion.minOrderAmount?.toString() ?? null,
    startsAt: promotion.startsAt.toISOString(),
    endsAt: promotion.endsAt.toISOString(),
    priority: promotion.priority,
    updatedAt: promotion.updatedAt.toISOString(),
    targetIds: targets,
    discountAmount: calculation.discountAmount.toFixed(2),
  };
}

export class PromotionsService {
  async options(businessId: string) {
    const [categories, products] = await Promise.all([
      prisma.category.findMany({
        where: { businessId, isActive: true },
        select: { id: true, name: true, parentId: true },
        orderBy: { name: "asc" },
      }),
      prisma.productTemplate.findMany({
        where: { businessId, isActive: true },
        select: { id: true, name: true, categoryId: true },
        orderBy: { name: "asc" },
      }),
    ]);
    return { categories, products };
  }

  async list(businessId: string) {
    const promotions = await prisma.promotion.findMany({
      where: { businessId },
      include: promotionInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const totals = await prisma.promotionRedemption.groupBy({
      by: ["promotionId"],
      where: { businessId },
      _sum: { discountAmount: true },
    });
    const totalById = new Map(totals.map(row => [row.promotionId, row._sum.discountAmount?.toString() ?? "0"]));
    return promotions.map(promotion => ({
      ...promotion,
      targetIds: promotion.targets
        .map(target => target.categoryId ?? target.productTemplateId)
        .filter((id): id is string => id !== null),
      usedCount: promotion._count.redemptions,
      totalDiscountAmount: totalById.get(promotion.id) ?? "0",
    }));
  }

  async create(businessId: string, authUserId: string, value: unknown) {
    const input = parseInput(value);
    return prisma.$transaction(async tx => {
      await validateTargets(tx, businessId, input.scope, input.targetIds);
      const createdBy = await actor(tx, authUserId);
      return tx.promotion.create({
        data: {
          businessId,
          createdBy,
          ...promotionData(input),
          targets: { create: targetRows(input, businessId) },
        },
        include: promotionInclude,
      });
    });
  }

  async update(businessId: string, promotionId: string, value: unknown) {
    const input = parseInput(value);
    return prisma.$transaction(async tx => {
      const current = await tx.promotion.findFirst({ where: { id: promotionId, businessId }, select: { id: true } });
      if (!current) throw new HttpError(404, "Promotion not found.");
      await validateTargets(tx, businessId, input.scope, input.targetIds);
      await tx.promotionTarget.deleteMany({ where: { businessId, promotionId } });
      return tx.promotion.update({
        where: { id: current.id },
        data: {
          ...promotionData(input),
          targets: { create: targetRows(input, businessId) },
        },
        include: promotionInclude,
      });
    });
  }

  async setStatus(businessId: string, promotionId: string, value: unknown) {
    const body = object(value);
    if (body.status !== "ACTIVE" && body.status !== "PAUSED") throw new HttpError(400, "status must be ACTIVE or PAUSED.");
    const result = await prisma.promotion.updateMany({
      where: { id: promotionId, businessId },
      data: { status: body.status },
    });
    if (!result.count) throw new HttpError(404, "Promotion not found.");
    return prisma.promotion.findFirst({ where: { id: promotionId, businessId }, include: promotionInclude });
  }

  async bestForCart(
    tx: Prisma.TransactionClient,
    businessId: string,
    cartLines: PromotionCartLine[],
    now = new Date(),
  ): Promise<PromotionCalculation | null> {
    const cartTotal = cartLines.reduce(
      (total, line) => total.plus(line.unitPrice.mul(line.quantity)),
      new Prisma.Decimal(0),
    );
    const promotions = await tx.promotion.findMany({
      where: { businessId, status: "ACTIVE", startsAt: { lte: now }, endsAt: { gt: now } },
      include: { targets: true, _count: { select: { redemptions: true } } },
    });
    const available = promotions.filter(promotion =>
      promotion.usageLimit === null || promotion._count.redemptions < promotion.usageLimit,
    );
    if (!available.length) return null;

    const categories = await tx.category.findMany({
      where: { businessId },
      select: { id: true, parentId: true },
    });
    const parentById = new Map(categories.map(category => [category.id, category.parentId]));
    const categoryAncestors = new Map<string, Set<string>>();
    for (const category of categories) {
      const ancestors = new Set<string>();
      let current: string | null = category.id;
      while (current && !ancestors.has(current)) {
        ancestors.add(current);
        current = parentById.get(current) ?? null;
      }
      categoryAncestors.set(category.id, ancestors);
    }

    const calculations = available
      .map(promotion => calculatePromotion({
        id: promotion.id,
        name: promotion.name,
        discountType: promotion.discountType,
        discountValue: promotion.discountValue,
        scope: promotion.scope,
        minOrderAmount: promotion.minOrderAmount,
        startsAt: promotion.startsAt,
        endsAt: promotion.endsAt,
        priority: promotion.priority,
        updatedAt: promotion.updatedAt,
        targets: promotion.targets,
      }, cartLines, cartTotal, categoryAncestors))
      .filter((value): value is PromotionCalculation => value !== null);
    return chooseBestPromotion(calculations);
  }

  snapshot(calculation: PromotionCalculation | null) {
    return calculation ? configSnapshot(calculation) : null;
  }

  async assertSnapshotStillValid(
    tx: Prisma.TransactionClient,
    businessId: string,
    calculation: PromotionCalculation | null,
    snapshot: Prisma.JsonValue | null,
  ) {
    const currentSnapshot = this.snapshot(calculation);
    if (JSON.stringify(currentSnapshot) !== JSON.stringify(snapshot)) {
      throw new HttpError(409, "Eligible promotions changed after this draft was created. Reload the order and confirm the updated total.");
    }
    if (!calculation) return;

    await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "promotions"
       WHERE "id" = ${calculation.promotion.id}::uuid
         AND "business_id" = ${businessId}::uuid
       FOR UPDATE
    `;
    const usedCount = await tx.promotionRedemption.count({
      where: { businessId, promotionId: calculation.promotion.id },
    });
    const limit = await tx.promotion.findFirst({
      where: { id: calculation.promotion.id, businessId },
      select: { usageLimit: true },
    });
    if (!limit || (limit.usageLimit !== null && usedCount >= limit.usageLimit)) {
      throw new HttpError(409, "This promotion has reached its usage limit. Reload the order before charging the customer.");
    }
  }
}

export const promotionsService = new PromotionsService();
