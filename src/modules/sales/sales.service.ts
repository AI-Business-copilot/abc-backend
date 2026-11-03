import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";
import { money, object, quantity, requiredText } from "../purchases/purchases.input";
import { filters, pagination, uuid } from "../purchases/purchases.query";
import { actor, atomic } from "../purchases/purchases-transaction";

const include = { orderItems: { include: { lot: true, variant: { select: { sku: true, template: { select: { name: true } } } } } }, orderPayments: true, customer: true } as const;
const zero = () => new Prisma.Decimal(0);

async function openShift(tx: Prisma.TransactionClient, businessId: string, userId: string, id?: string) {
  const shift = await tx.cashShift.findFirst({ where: { id, businessId, userId, status: "OPEN" }, orderBy: [{ openedAt: "desc" }, { id: "desc" }] });
  if (!shift) throw new HttpError(409, "Open a cash shift owned by the current user first.");
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
      ? { lot: { is: { businessId, variantId, expirationDate: { gte: today } } } }
      : { lotId: null }) }, include: { lot: true },
  });
  balances.sort((a, b) => (a.lot?.expirationDate.getTime() ?? 0) - (b.lot?.expirationDate.getTime() ?? 0) || a.id.localeCompare(b.id));
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
      let total = zero();
      for (const line of lines.sort((a, b) => a.variantId.localeCompare(b.variantId))) {
        const { variant } = await allocateStock(tx, businessId, line.variantId, line.quantity);
        const subtotal = money(variant.basePrice.mul(line.quantity).toFixed(2), "subtotal");
        total = total.plus(subtotal);
        items.push({ ...line, unitPrice: variant.basePrice, unitCost: variant.costPrice, subtotal });
      }
      money(total.toFixed(2), "totalNetAmount");
      return tx.order.create({ data: { businessId, shiftId: shift.id, cashierId: userId, customerId, orderCode, status: "DRAFT", totalGrossAmount: total, totalNetAmount: total, orderItems: { create: items } }, include });
    });
  }

  async complete(businessId: string, authUserId: string, value: string, input: unknown) {
    const id = uuid(value, "orderId");
    const body = object(input);
    if (body.confirmed !== true) throw new HttpError(400, "confirmed must be true after verifying receipt of payment.");
    if (body.paymentMethod !== "CASH" && body.paymentMethod !== "BANK_TRANSFER") throw new HttpError(400, "paymentMethod must be CASH or BANK_TRANSFER.");
    const paymentMethod = body.paymentMethod;
    const amount = money(body.amount, "amount");
    if (amount.lte(0)) throw new HttpError(400, "Payment must be positive.");
    const paymentReference = body.paymentReference === undefined ? undefined : requiredText(body.paymentReference, "paymentReference", 100);
    return atomic(async tx => {
      const userId = await actor(tx, authUserId);
      const order = await tx.order.findFirst({ where: { id, businessId }, include });
      if (!order) throw new HttpError(404, "Order not found.");
      if (order.status !== "DRAFT") throw new HttpError(409, "Only a draft can be paid; check order details before retrying.");
      await openShift(tx, businessId, userId, order.shiftId);
      if (order.cashierId !== userId) throw new HttpError(403, "Only the order cashier can complete this draft.");
      if (!amount.eq(order.totalNetAmount)) throw new HttpError(400, "Payment must equal the order total.");
      if (order.orderPayments.length) throw new HttpError(409, "Draft already has payments; reconciliation required.");
      if (!order.orderItems.length || !order.discountAmount.eq(0) || order.orderItems.some(line => !line.discountAmount.eq(0))) throw new HttpError(409, "Unsupported draft contents; reconciliation required.");
      let cogs = zero();
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      for (const line of [...order.orderItems].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
        const { variant, allocations } = await allocateStock(tx, businessId, line.variantId, line.quantity);
        for (const { balance, quantity } of allocations) {
          const cost = variant.costPrice.mul(quantity);
          cogs = cogs.plus(cost);
          money(cogs.toFixed(2), "totalCogsAmount");
          const balanceAfter = balance.quantityOnHand - quantity;
          await tx.inventoryBalance.update({ where: { id: balance.id }, data: { quantityOnHand: balanceAfter, updatedAt: new Date(), outOfStockSince: balanceAfter === 0 ? new Date() : null } });
          await tx.orderItem.create({ data: { orderId: id, variantId: variant.id, lotId: balance.lotId, quantity, unitPrice: line.unitPrice, unitCost: variant.costPrice, subtotal: line.unitPrice.mul(quantity) } });
          await tx.inventoryLedger.create({ data: { businessId, variantId: variant.id, lotId: balance.lotId, transactionType: "POS_SALE", quantityChanged: -quantity, balanceAfter, unitCost: variant.costPrice, totalCostValue: cost.negated(), referenceDocType: "ORDER", referenceDocId: id, createdBy: userId } });
        }
      }
      await tx.orderPayment.create({ data: { orderId: id, shiftId: order.shiftId, paymentMethod, amount, paymentReference } });
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
