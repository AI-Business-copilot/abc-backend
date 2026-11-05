import { validateSupplierOrder } from "./supplier-order";
import { Prisma } from "@prisma/client";
import { HttpError } from "../../shared/http/http-error";
import { object, orderInput, money } from "./purchases.input";
import { uuid } from "./purchases.query";
import { actor, atomic, supplierInBusiness } from "./purchases-transaction";

async function loadOrder(tx: Prisma.TransactionClient, businessId: string, id: string) {
  const order = await tx.purchaseOrder.findFirst({ where: { id, businessId }, include: { purchaseOrderItems: true } });
  if (!order) throw new HttpError(404, "Purchase order not found.");
  return order;
}

export class PurchasesLifecycleService {
  async updateOrder(businessId: string, authUserId: string, orderId: string, value: unknown) {
    const id = uuid(orderId, "orderId");
    const patch = object(value);
    const keys = Object.keys(patch);
    if (!keys.length || keys.some((key) => !["poCode", "supplierId", "orderDate", "expectedDeliveryDate", "items"].includes(key))) throw new HttpError(400, "Invalid PO update fields.");
    return atomic(async (tx) => {
      await actor(tx, authUserId);
      const order = await loadOrder(tx, businessId, id);
      // Preserve item IDs: existing clients/drafts may refer to them.
      if (order.status !== "ORDERED" || order.purchaseOrderItems.some((item) => item.receivedQty > 0) || await tx.purchaseReceipt.count({ where: { businessId, poId: id } })) throw new HttpError(409, "Only purchase orders without any receipts can be edited.");
      const input = orderInput({
        poCode: order.poCode, supplierId: order.supplierId,
        orderDate: order.orderDate.toISOString().slice(0, 10),
        expectedDeliveryDate: order.expectedDeliveryDate?.toISOString().slice(0, 10),
        items: order.purchaseOrderItems.map((item) => ({ variantId: item.variantId, orderedQty: item.orderedQty, unitPrice: item.unitPrice.toFixed(2) })),
        ...patch,
      });
      // Existing unchanged lines remain editable when a catalog entry was retired.
      const changedLines = input.items.filter(line => input.supplierId !== order.supplierId || !order.purchaseOrderItems.some(old => old.variantId === line.variantId && old.orderedQty === line.orderedQty && old.unitPrice.eq(line.unitPrice)));
      if (changedLines.length) await validateSupplierOrder(tx, businessId, input.supplierId, changedLines);
      const variants = await tx.productVariant.findMany({ where: { businessId, isActive: true, id: { in: input.items.map((item) => item.variantId) } } });
      if (variants.length !== input.items.length) throw new HttpError(404, "An active SKU was not found in this business.");
      const wanted = new Set(input.items.map((item) => item.variantId));
      await tx.purchaseOrderItem.deleteMany({ where: { poId: id, variantId: { notIn: [...wanted] } } });
      for (const item of input.items) {
        const existing = order.purchaseOrderItems.find((row) => row.variantId === item.variantId);
        if (existing) await tx.purchaseOrderItem.update({ where: { id: existing.id }, data: { orderedQty: item.orderedQty, unitPrice: item.unitPrice } });
        else await tx.purchaseOrderItem.create({ data: { ...item, poId: id } });
      }
      const { items, ...data } = input;
      return tx.purchaseOrder.update({ where: { id }, data, include: { purchaseOrderItems: true } });
    });
  }

  async finishOrder(businessId: string, authUserId: string, orderId: string, action: "cancel" | "close") {
    const id = uuid(orderId, "orderId");
    return atomic(async (tx) => {
      await actor(tx, authUserId);
      const order = await loadOrder(tx, businessId, id);
      const status = action === "cancel" ? "CANCELLED" : "CLOSED_SHORT";
      if (order.status === status) return order;
      if (!["ORDERED", "PARTIALLY_RECEIVED"].includes(order.status)) throw new HttpError(409, "Purchase order is already closed.");
      const hasReceived = order.purchaseOrderItems.some((item) => item.receivedQty > 0);
      if (action === "cancel" && (hasReceived || await tx.purchaseReceipt.count({ where: { businessId, poId: id, status: "RECEIVED" } }))) throw new HttpError(409, "Received orders cannot be cancelled. Close the remaining quantity instead.");
      if (action === "close" && (!hasReceived || order.purchaseOrderItems.every((item) => item.receivedQty === item.orderedQty))) throw new HttpError(409, "Only partially received orders can be closed short.");
      return tx.purchaseOrder.update({ where: { id }, data: { status }, include: { purchaseOrderItems: true } });
    });
  }

  async reconcileDebt(businessId: string, authUserId: string, supplierId: string, value?: unknown) {
    const id = uuid(supplierId, "supplierId");
    const body = value === undefined ? undefined : object(value);
    if (body && body.apply !== true) throw new HttpError(400, "Explicit apply: true is required to reconcile supplier debt.");
    return atomic(async (tx) => {
      await actor(tx, authUserId);
      const supplier = await supplierInBusiness(tx, businessId, id);
      const [receipts, returns] = await Promise.all([
        tx.purchaseReceipt.aggregate({ where: { businessId, supplierId: id, status: "RECEIVED" }, _sum: { totalAmount: true, paidAmount: true } }),
        tx.vendorReturn.aggregate({ where: { businessId, supplierId: id, status: "COMPLETED" }, _sum: { totalReturnValue: true } }),
      ]);
      const receiptDebt = new Prisma.Decimal(receipts._sum.totalAmount ?? 0).minus(receipts._sum.paidAmount ?? 0);
      const returnCredit = new Prisma.Decimal(returns._sum.totalReturnValue ?? 0);
      const calculatedDebt = receiptDebt.minus(returnCredit);
      const storedDebt = new Prisma.Decimal(supplier.debtAmount ?? 0);
      // Expected stored amount prevents a preview from overwriting intervening changes.
      if (body) {
        const expected = body.expectedDebtAmount;
        if (typeof expected !== "string" || !/^-?\d+(\.\d{1,2})?$/.test(expected)) throw new HttpError(400, "expectedDebtAmount must match the preview storedDebtAmount.");
        money(expected.replace(/^-/, ""), "expectedDebtAmount");
        if (!storedDebt.eq(expected)) throw new HttpError(409, "Supplier debt changed since preview. Preview again.");
        if (calculatedDebt.abs().gte("10000000000")) throw new HttpError(400, "Calculated debt exceeds database precision.");
        await tx.supplier.update({ where: { id }, data: { debtAmount: calculatedDebt } });
      }
      return {
        supplierId: id, storedDebtAmount: storedDebt.toFixed(2), receiptDebtAmount: receiptDebt.toFixed(2),
        vendorReturnCreditAmount: returnCredit.toFixed(2), calculatedDebtAmount: calculatedDebt.toFixed(2),
        difference: calculatedDebt.minus(storedDebt).toFixed(2), applied: Boolean(body),
        basis: "Received purchase receipts minus completed vendor returns. Opening debt and external adjustments are not included.",
      };
    });
  }
}

export const purchasesLifecycleService = new PurchasesLifecycleService();
