import { supplierInput } from "./suppliers.input";
import { validateSupplierOrder } from "./supplier-order";
import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";
import { money, object, orderInput, purchaseToday, receiptInput } from "./purchases.input";
import { uuid } from "./purchases.query";
import { recordSupplierPayment } from "./purchases-payments.service";
import { actor, atomic, supplierInBusiness, changeDebt } from "./purchases-transaction";
import { orderFingerprint } from "./purchases-fingerprint";

export class PurchasesWriteService {
  async createSupplier(businessId: string, value: unknown) {
    const data = supplierInput(value);
    return prisma.supplier.create({ data: { ...data, businessId, name: data.name! } });
  }

  async updateSupplier(businessId: string, id: string, value: unknown) {
    const supplierId = uuid(id, "supplierId");
    const data = supplierInput(value, true);
    return atomic(async tx => {
      await supplierInBusiness(tx, businessId, supplierId);
      if (data.isActive === false) await tx.supplierProduct.updateMany({ where: { businessId, supplierId, isPreferred: true }, data: { isPreferred: false } });
      return tx.supplier.update({ where: { id: supplierId }, data });
    });
  }

  async createOrder(businessId: string, authUserId: string, value: unknown) {
    const input = orderInput(value);
    if (input.orderDate.toISOString().slice(0, 10) < purchaseToday()) {
      throw new HttpError(400, "Ngày đặt không được trước hôm nay.");
    }
    return atomic(async (tx) => {
      const createdBy = await actor(tx, authUserId);
      await validateSupplierOrder(tx, businessId, input.supplierId, input.items);
      const variants = await tx.productVariant.findMany({ where: { businessId, id: { in: input.items.map((item) => item.variantId) }, isActive: true } });
      if (variants.length !== input.items.length) throw new HttpError(404, "An active SKU was not found in this business.");
      const { items, ...data } = input;
      return tx.purchaseOrder.create({
        data: { ...data, businessId, createdBy, status: "ORDERED", purchaseOrderItems: { create: items } },
        include: { purchaseOrderItems: true },
      });
    });
  }

  async receiveOrder(businessId: string, authUserId: string, orderId: string, value: unknown, expectedOrderFingerprint?: string) {
    const id = uuid(orderId, "orderId");
    const input = receiptInput(value);
    return atomic(async (tx) => {
      const createdBy = await actor(tx, authUserId);
      const order = await tx.purchaseOrder.findFirst({ where: { id, businessId }, include: { purchaseOrderItems: true } });
      if (!order) throw new HttpError(404, "Purchase order not found.");
      if (expectedOrderFingerprint) {
        const actual = orderFingerprint(order);
        if (actual !== expectedOrderFingerprint) throw new HttpError(409, "Purchase order changed since counting. Preview again.");
      }
      if (!["ORDERED", "PARTIALLY_RECEIVED"].includes(order.status)) throw new HttpError(409, "Purchase order is no longer open for receiving.");
      await supplierInBusiness(tx, businessId, order.supplierId);
      const poItems = new Map(order.purchaseOrderItems.map((item) => [item.id, item]));
      const incoming = new Map<string, number>();
      for (const line of input.items) {
        const item = poItems.get(line.poItemId);
        if (!item) throw new HttpError(400, "Receipt line does not belong to this purchase order.");
        const quantity = (incoming.get(item.id) ?? 0) + line.receivedQty;
        if (quantity + item.receivedQty > item.orderedQty) throw new HttpError(400, "Received quantity exceeds remaining ordered quantity.");
        incoming.set(item.id, quantity);
      }
      const variants = await tx.productVariant.findMany({
        where: { businessId, id: { in: order.purchaseOrderItems.filter((item) => incoming.has(item.id)).map((item) => item.variantId) } },
        include: { template: { select: { hasLotTracking: true } } },
      });
      const variantMap = new Map(variants.map((variant) => [variant.id, variant]));
      const receipt = await tx.purchaseReceipt.create({ data: {
        businessId, poId: id, supplierId: order.supplierId, createdBy, receiptCode: input.receiptCode,
        totalAmount: input.totalAmount, paidAmount: input.paidAmount, status: "RECEIVED",
      } });
      await recordSupplierPayment(tx, businessId, createdBy, receipt.id, input.paidAmount, object(value).shiftId);
      // Stable SKU order reduces deadlocks when different POs share SKUs.
      const lines = [...input.items].sort((a, b) => poItems.get(a.poItemId)!.variantId.localeCompare(poItems.get(b.poItemId)!.variantId));
      const costing = new Map<string, { quantity: number; value: Prisma.Decimal }>();
      for (const line of lines) {
        const item = poItems.get(line.poItemId)!;
        const variant = variantMap.get(item.variantId);
        if (!variant || !variant.isActive) throw new HttpError(404, "Active SKU not found in this business.");
        if (variant.isLockedForAudit) throw new HttpError(409, "SKU is locked for stock audit.");
        let lotId: string | null = null;
        if (variant.template.hasLotTracking) {
          if (!line.lotNumber || !line.expirationDate) throw new HttpError(400, "Lot-tracked SKU requires lotNumber and expirationDate.");
          assertUsableLot(line.expirationDate);
          const where = { businessId_variantId_lotNumber: { businessId, variantId: variant.id, lotNumber: line.lotNumber } };
          let lot = await tx.productLot.findUnique({ where });
          if (lot) {
            if (lot.expirationDate.getTime() !== line.expirationDate.getTime() || (line.manufacturingDate && lot.manufacturingDate?.getTime() !== line.manufacturingDate.getTime())) throw new HttpError(409, "Existing lot has different dates.");
          } else {
            lot = await tx.productLot.create({ data: { businessId, variantId: variant.id, lotNumber: line.lotNumber, expirationDate: line.expirationDate, manufacturingDate: line.manufacturingDate } });
          }
          lotId = lot.id;
        } else if (line.lotNumber || line.expirationDate || line.manufacturingDate) {
          throw new HttpError(400, "SKU does not use lot tracking.");
        }
        const total = await tx.inventoryBalance.aggregate({ where: { businessId, variantId: variant.id }, _sum: { quantityOnHand: true } });
        const onHand = total._sum.quantityOnHand ?? 0;
        if (onHand + line.receivedQty > 2_147_483_647) throw new HttpError(400, "Inventory quantity exceeds supported range.");
        // Keep unrounded totals across multiple lots of the same SKU in this receipt.
        const cost = costing.get(variant.id) ?? { quantity: Math.max(0, onHand), value: variant.costPrice.mul(Math.max(0, onHand)) };
        cost.quantity += line.receivedQty;
        cost.value = cost.value.plus(line.actualCost.mul(line.receivedQty));
        costing.set(variant.id, cost);
        const costPrice = cost.value.div(cost.quantity).toDecimalPlaces(2);
        await tx.productVariant.update({ where: { id: variant.id }, data: { costPrice, updatedAt: new Date() } });
        variant.costPrice = costPrice;
        const balance = await tx.inventoryBalance.findFirst({ where: { businessId, variantId: variant.id, lotId } });
        if (balance) {
          if (balance.quantityOnHand + line.receivedQty > 2_147_483_647) throw new HttpError(400, "Lot inventory exceeds supported range.");
          await tx.inventoryBalance.update({ where: { id: balance.id }, data: { quantityOnHand: { increment: line.receivedQty }, outOfStockSince: null, updatedAt: new Date() } });
        } else {
          await tx.inventoryBalance.create({ data: { businessId, variantId: variant.id, lotId, quantityOnHand: line.receivedQty } });
        }
        await tx.purchaseReceiptItem.create({ data: { receiptId: receipt.id, poItemId: item.id, variantId: variant.id, lotId, receivedQty: line.receivedQty, actualCost: line.actualCost } });
        await tx.inventoryLedger.create({ data: {
          businessId, variantId: variant.id, lotId, transactionType: "PURCHASE_RECEIPT",
          quantityChanged: line.receivedQty, balanceAfter: onHand + line.receivedQty,
          unitCost: line.actualCost, totalCostValue: line.actualCost.mul(line.receivedQty),
          referenceDocType: "PURCHASE_RECEIPT", referenceDocId: receipt.id, createdBy,
        } });
      }
      for (const [itemId, receivedQty] of incoming) {
        await tx.purchaseOrderItem.update({ where: { id: itemId }, data: { receivedQty: { increment: receivedQty } } });
      }
      const completed = order.purchaseOrderItems.every((item) => item.receivedQty + (incoming.get(item.id) ?? 0) === item.orderedQty);
      await tx.purchaseOrder.update({ where: { id }, data: { status: completed ? "COMPLETED" : "PARTIALLY_RECEIVED" } });
      await changeDebt(tx, businessId, order.supplierId, input.totalAmount.minus(input.paidAmount));
      return tx.purchaseReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: { purchaseReceiptItems: true } });
    });
  }

  async updatePayment(businessId: string, authUserId: string, receiptId: string, value: unknown) {
    const id = uuid(receiptId, "receiptId");
    // Absolute cumulative payment makes repeating the same request harmless.
    const paidAmount = money(object(value).paidAmount, "paidAmount", 14);
    return atomic(async (tx) => {
      const createdBy = await actor(tx, authUserId);
      const receipt = await tx.purchaseReceipt.findFirst({ where: { id, businessId } });
      if (!receipt) throw new HttpError(404, "Purchase receipt not found.");
      if (receipt.status !== "RECEIVED") throw new HttpError(409, "Only received documents can be paid.");
      if (paidAmount.lt(receipt.paidAmount) || paidAmount.gt(receipt.totalAmount)) throw new HttpError(400, "paidAmount must be between the amount already paid and receipt total.");
      await recordSupplierPayment(tx, businessId, createdBy, id, paidAmount.minus(receipt.paidAmount), object(value).shiftId);
      await changeDebt(tx, businessId, receipt.supplierId, receipt.paidAmount.minus(paidAmount));
      const updated = await tx.purchaseReceipt.update({ where: { id }, data: { paidAmount } });
      return { ...updated, debtAmount: updated.totalAmount.minus(updated.paidAmount).toFixed(2) };
    });
  }
}

export const purchasesWriteService = new PurchasesWriteService();

// An expiration date remains usable throughout that date in the shop's timezone.
export function assertUsableLot(expirationDate: Date, now = new Date()) {
  const shopToday = new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (expirationDate.toISOString().slice(0, 10) < shopToday) throw new HttpError(400, "Expired lots cannot be received.");
}
