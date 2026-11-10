import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";
import { money, object, quantity, requiredText } from "../purchases/purchases.input";
import { filters, pagination, uuid } from "../purchases/purchases.query";
import { actor, atomic } from "../purchases/purchases-transaction";
import { promotionsService } from "../promotions/promotions.service";
import type { PromotionCartLine } from "../promotions/promotion-calculator";

const include = { orderItems: { include: { lotItem: { include: { lot: true } }, variant: { select: { sku: true, template: { select: { id: true, name: true, categoryId: true } } } } } }, orderPayments: true, customer: true } as const;
const zero = () => new Prisma.Decimal(0);

async function openShift(tx: Prisma.TransactionClient, businessId: string, userId: string, id?: string) {
  const shift = await tx.cashShift.findFirst({ where: { id, businessId, userId, status: "OPEN" }, orderBy: [{ openedAt: "desc" }, { id: "desc" }] });
  if (!shift) throw new HttpError(409, "Open a cash shift owned by the current user first.");
  const lockedShift = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
      FROM "cash_shifts"
     WHERE "id" = ${shift.id}::uuid
       AND "business_id" = ${businessId}::uuid
       AND "user_id" = ${userId}::uuid
       AND "status" = 'OPEN'
     FOR UPDATE
  `;
  if (!lockedShift.length) throw new HttpError(409, "Open a cash shift owned by the current user first.");
  return shift;
}

/** A draft does not reserve stock. Always allocate again inside payment's transaction. */
export async function allocateStock(tx: Prisma.TransactionClient, businessId: string, variantId: string, requested: number) {
  const variant = await tx.productVariant.findFirst({ where: { id: variantId, businessId }, include: { template: true } });
  if (!variant?.isActive) throw new HttpError(404, "Active SKU not found in this business.");
  if (variant.isLockedForAudit) throw new HttpError(409, "SKU is locked for stock audit.");
  const today = new Date(new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10));
  const balances = await tx.inventoryBalance.findMany({
    where: { businessId, variantId, ...(variant.template.hasLotTracking
      ? { lotItem: { is: { businessId, variantId, expirationDate: { gte: today } } } }
      : { lotItemId: null }) }, include: { lotItem: true },
  });
  balances.sort((a, b) => (a.lotItem?.expirationDate.getTime() ?? 0) - (b.lotItem?.expirationDate.getTime() ?? 0) || a.id.localeCompare(b.id));
  let remaining = requested;
  const allocations = [];
  for (const balance of balances) {
    const take = Math.min(remaining, Math.max(0, balance.quantityOnHand - balance.damagedQuantity));
    if (take) allocations.push({ balance, quantity: take });
    remaining -= take;
    if (!remaining) break;
  }
  if (remaining) throw new HttpError(409, `Insufficient sellable stock for SKU ${variant.sku}.`);
  return { variant, allocations };
}

export class SalesService {
  async previewPromotion(businessId: string, value: unknown) {
    const body = object(value);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 500) throw new HttpError(400, "items must contain 1-500 lines.");
    const lines = body.items.map(value => {
      const line = object(value);
      return { variantId: uuid(line.variantId, "variantId"), quantity: quantity(line.quantity) };
    });
    if (new Set(lines.map(line => line.variantId)).size !== lines.length) throw new HttpError(400, "Duplicate SKU.");
    return prisma.$transaction(async tx => {
      const variants = await tx.productVariant.findMany({
        where: { businessId, id: { in: lines.map(line => line.variantId) }, isActive: true },
        include: { template: { select: { id: true, categoryId: true } } },
      });
      if (variants.length !== lines.length) throw new HttpError(404, "One or more active SKUs were not found in this business.");
      const variantById = new Map(variants.map(variant => [variant.id, variant]));
      const cart: PromotionCartLine[] = lines.map(line => {
        const variant = variantById.get(line.variantId)!;
        return {
          ...line,
          productTemplateId: variant.template.id,
          categoryId: variant.template.categoryId,
          unitPrice: variant.basePrice,
        };
      });
      const gross = cart.reduce((sum, line) => sum.plus(line.unitPrice.mul(line.quantity)), zero());
      const promotion = await promotionsService.bestForCart(tx, businessId, cart);
      return {
        totalGrossAmount: gross.toFixed(2),
        discountAmount: promotion?.discountAmount.toFixed(2) ?? "0.00",
        totalNetAmount: gross.minus(promotion?.discountAmount ?? zero()).toFixed(2),
        promotion: promotion ? { id: promotion.promotion.id, name: promotion.promotion.name } : null,
        lineDiscounts: Object.fromEntries([...(promotion?.lineDiscounts ?? new Map())].map(([id, amount]) => [id, amount.toFixed(2)])),
      };
    });
  }

  async list(businessId: string, query: Record<string, unknown>, customers = false) {
    const f = filters(query, ["DRAFT", "COMPLETED", "CANCELLED"]);
    if (customers) {
      const where: Prisma.CustomerWhereInput = { businessId, ...(f.search ? { OR: [{ name: { contains: f.search, mode: "insensitive" } }, { phone: { contains: f.search } }] } : {}) };
      return prisma.$transaction(async tx => ({ items: await tx.customer.findMany({ where, skip: f.skip, take: f.pageSize, orderBy: { id: "desc" } }), pagination: pagination(f.page, f.pageSize, await tx.customer.count({ where })) }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    }
    const where: Prisma.OrderWhereInput = { businessId, status: f.status, createdAt: f.dateRange, ...(f.search ? { orderCode: { contains: f.search, mode: "insensitive" } } : {}) };
    return prisma.$transaction(async tx => ({ items: await tx.order.findMany({ where, include, skip: f.skip, take: f.pageSize, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }), pagination: pagination(f.page, f.pageSize, await tx.order.count({ where })) }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async get(businessId: string, value: string) {
    const id = uuid(value, "orderId");
    return prisma.$transaction(async tx => {
      const order = await tx.order.findFirst({ where: { id, businessId }, include });
      if (!order) throw new HttpError(404, "Order not found.");
      const inventoryLedger = await tx.inventoryLedger.findMany({ where: { businessId, referenceDocType: "ORDER", referenceDocId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      return { ...order, inventoryLedger };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async createCustomer(businessId: string, value: unknown) {
    const body = object(value);
    return prisma.customer.create({ data: { businessId, name: requiredText(body.name, "name", 150), phone: requiredText(body.phone, "phone", 20) } });
  }

  async create(businessId: string, authUserId: string, value: unknown) {
    const body = object(value);
    const orderCode = requiredText(body.orderCode, "orderCode", 50);
    const customerId = body.customerId === undefined ? undefined : uuid(body.customerId, "customerId");
    const shiftId = body.shiftId === undefined ? undefined : uuid(body.shiftId, "shiftId");
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 500) throw new HttpError(400, "items must contain 1-500 lines.");
    const lines = body.items.map(value => { const line = object(value); return { variantId: uuid(line.variantId, "variantId"), quantity: quantity(line.quantity) }; });
    if (new Set(lines.map(l => l.variantId)).size !== lines.length) throw new HttpError(400, "Duplicate SKU.");
    return atomic(async tx => {
      const userId = await actor(tx, authUserId);
      const shift = await openShift(tx, businessId, userId, shiftId);
      if (customerId && !await tx.customer.findFirst({ where: { id: customerId, businessId } })) throw new HttpError(404, "Customer not found.");
      const items = [];
      const cart: PromotionCartLine[] = [];
      let total = zero();
      for (const line of lines.sort((a, b) => a.variantId.localeCompare(b.variantId))) {
        const { variant } = await allocateStock(tx, businessId, line.variantId, line.quantity);
        const subtotal = money(variant.basePrice.mul(line.quantity).toFixed(2), "subtotal");
        total = total.plus(subtotal);
        items.push({ ...line, unitPrice: variant.basePrice, unitCost: variant.costPrice, subtotal });
        cart.push({
          ...line,
          productTemplateId: variant.template.id,
          categoryId: variant.template.categoryId,
          unitPrice: variant.basePrice,
        });
      }
      money(total.toFixed(2), "totalGrossAmount");
      const promotion = await promotionsService.bestForCart(tx, businessId, cart);
      const discountAmount = promotion?.discountAmount ?? zero();
      const discountedItems = items.map(item => ({
        ...item,
        discountAmount: promotion?.lineDiscounts.get(item.variantId) ?? zero(),
      }));
      const totalNetAmount = total.minus(discountAmount);
      money(totalNetAmount.toFixed(2), "totalNetAmount");
      return tx.order.create({
        data: {
          businessId,
          shiftId: shift.id,
          cashierId: userId,
          customerId,
          orderCode,
          status: "DRAFT",
          totalGrossAmount: total,
          discountAmount,
          totalNetAmount,
          promotionId: promotion?.promotion.id,
          promotionSnapshot: promotionsService.snapshot(promotion) ?? Prisma.DbNull,
          orderItems: { create: discountedItems },
        },
        include,
      });
    });
  }

  async complete(businessId: string, authUserId: string, value: string, input: unknown) {
    const id = uuid(value, "orderId");
    const body = object(input);
    if (body.confirmed !== true) throw new HttpError(400, "confirmed must be true after verifying receipt of payment.");
    if (body.paymentMethod !== "CASH" && body.paymentMethod !== "BANK_TRANSFER") throw new HttpError(400, "paymentMethod must be CASH or BANK_TRANSFER.");
    const paymentMethod = body.paymentMethod;
    const amount = money(body.amount, "amount");
    if (amount.lt(0)) throw new HttpError(400, "Payment cannot be negative.");
    const paymentReference = body.paymentReference === undefined ? undefined : requiredText(body.paymentReference, "paymentReference", 100);
    return atomic(async tx => {
      const userId = await actor(tx, authUserId);
      const order = await tx.order.findFirst({ where: { id, businessId }, include });
      if (!order) throw new HttpError(404, "Order not found.");
      if (order.status !== "DRAFT") throw new HttpError(409, "Only a draft can be paid; check order details before retrying.");
      const completedPaymentMethod = order.totalNetAmount.isZero() ? "PROMOTION" : paymentMethod;
      await openShift(tx, businessId, userId, order.shiftId);
      if (order.cashierId !== userId) throw new HttpError(403, "Only the order cashier can complete this draft.");
      if (!amount.eq(order.totalNetAmount)) throw new HttpError(400, "Payment must equal the order total.");
      if (amount.isZero() && !order.totalNetAmount.isZero()) throw new HttpError(400, "A zero payment is allowed only for a fully discounted order.");
      if (order.orderPayments.length) throw new HttpError(409, "Draft already has payments; reconciliation required.");
      if (!order.orderItems.length) throw new HttpError(409, "Empty draft contents; reconciliation required.");
      const cart: PromotionCartLine[] = order.orderItems.map(line => ({
        variantId: line.variantId,
        productTemplateId: line.variant.template.id,
        categoryId: line.variant.template.categoryId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      }));
      const promotion = await promotionsService.bestForCart(tx, businessId, cart);
      await promotionsService.assertSnapshotStillValid(tx, businessId, promotion, order.promotionSnapshot);
      if (!order.discountAmount.eq(promotion?.discountAmount ?? zero())) {
        throw new HttpError(409, "The order discount no longer matches its promotion. Reload the order before charging the customer.");
      }
      const discountByVariant = new Map(order.orderItems.map(line => [line.variantId, line.discountAmount]));
      let cogs = zero();
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      for (const line of [...order.orderItems].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
        const { variant, allocations } = await allocateStock(tx, businessId, line.variantId, line.quantity);
        const lineDiscount = discountByVariant.get(line.variantId) ?? zero();
        let remainingDiscount = lineDiscount;
        for (const [allocationIndex, { balance, quantity }] of allocations.entries()) {
          const cost = variant.costPrice.mul(quantity);
          cogs = cogs.plus(cost);
          money(cogs.toFixed(2), "totalCogsAmount");
          const balanceAfter = balance.quantityOnHand - quantity;
          const allocatedDiscount = allocationIndex === allocations.length - 1
            ? remainingDiscount
            : Prisma.Decimal.min(
                remainingDiscount,
                lineDiscount.mul(quantity).div(line.quantity).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
              );
          remainingDiscount = remainingDiscount.minus(allocatedDiscount);
          await tx.inventoryBalance.update({ where: { id: balance.id }, data: { quantityOnHand: balanceAfter, updatedAt: new Date(), outOfStockSince: balanceAfter === 0 ? new Date() : null } });
          await tx.orderItem.create({ data: { orderId: id, variantId: variant.id, lotItemId: balance.lotItemId, quantity, unitPrice: line.unitPrice, unitCost: variant.costPrice, discountAmount: allocatedDiscount, subtotal: line.unitPrice.mul(quantity) } });
          await tx.inventoryLedger.create({ data: { businessId, variantId: variant.id, lotItemId: balance.lotItemId, transactionType: "POS_SALE", quantityChanged: -quantity, balanceAfter, unitCost: variant.costPrice, totalCostValue: cost.negated(), referenceDocType: "ORDER", referenceDocId: id, createdBy: userId } });
        }
      }
      if (promotion) {
        await tx.promotionRedemption.create({
          data: {
            businessId,
            promotionId: promotion.promotion.id,
            orderId: id,
            discountAmount: promotion.discountAmount,
          },
        });
      }
      await tx.orderPayment.create({ data: { orderId: id, shiftId: order.shiftId, paymentMethod: completedPaymentMethod, amount, paymentReference } });
      if (completedPaymentMethod === "CASH") {
        await tx.cashTransaction.create({
          data: {
            businessId,
            shiftId: order.shiftId,
            transactionType: "IN",
            category: "POS_SALE",
            amount,
            refDocType: "ORDER",
            refDocId: id,
            recipientOrPayer: order.customer?.name ?? "Khách lẻ",
            notes: `Thu tiền mặt hóa đơn ${order.orderCode}`,
            createdBy: userId,
          },
        });
      }
      return tx.order.update({ where: { id }, data: { status: "COMPLETED", totalCogsAmount: cogs, grossProfit: order.totalNetAmount.minus(cogs) }, include });
    });
  }

  async cancel(businessId: string, authUserId: string, value: string) {
    const id = uuid(value, "orderId");
    return atomic(async tx => {
      const userId = await actor(tx, authUserId);
      const order = await tx.order.findFirst({ where: { id, businessId }, include });
      if (!order) throw new HttpError(404, "Order not found.");
      if (order.cashierId !== userId) throw new HttpError(403, "Only the cashier can cancel this draft.");
      if (order.status === "CANCELLED") return order;
      if (order.status !== "DRAFT" || order.orderPayments.length) throw new HttpError(409, "Only an unpaid draft can be cancelled.");
      return tx.order.update({ where: { id }, data: { status: "CANCELLED" }, include });
    });
  }
}

export const salesService = new SalesService();
