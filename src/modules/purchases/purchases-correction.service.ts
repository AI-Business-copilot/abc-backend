import { Prisma } from "@prisma/client";
import { HttpError } from "../../shared/http/http-error";
import { money, object, quantity } from "./purchases.input";
import { uuid } from "./purchases.query";
import { actor, atomic, changeDebt } from "./purchases-transaction";

export class PurchasesCorrectionService {
  async correctReceipt(businessId: string, authUserId: string, receiptId: string, value: unknown) {
    const id = uuid(receiptId, "receiptId");
    const body = object(value);
    const expectedTotal = money(body.expectedTotalAmount, "expectedTotalAmount", 14);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 500) throw new HttpError(400, "items must contain 1-500 receipt line corrections.");
    const items = body.items.map((raw) => {
      const item = object(raw);
      return {
        id: uuid(item.id, "receiptItemId"), receivedQty: quantity(item.receivedQty), actualCost: money(item.actualCost, "actualCost"),
        expectedReceivedQty: quantity(item.expectedReceivedQty), expectedActualCost: money(item.expectedActualCost, "expectedActualCost"),
      };
    });
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new HttpError(400, "Duplicate receipt line correction.");
    return atomic(async (tx) => {
      const createdBy = await actor(tx, authUserId);
      const receipt = await tx.purchaseReceipt.findFirst({ where: { id, businessId }, include: { purchaseReceiptItems: true } });
      if (!receipt) throw new HttpError(404, "Purchase receipt not found.");
      if (receipt.status !== "RECEIVED" || !receipt.poId) throw new HttpError(409, "Only received PO receipts can be corrected.");
      if (!receipt.totalAmount.eq(expectedTotal)) throw new HttpError(409, "Receipt changed since it was loaded. Reload before correcting.");
      if (await tx.vendorReturn.count({ where: { businessId, receiptId: id, status: { not: "CANCELLED" } } })) throw new HttpError(409, "Receipt has vendor returns and cannot be corrected directly.");
      const order = await tx.purchaseOrder.findFirst({ where: { id: receipt.poId, businessId }, include: { purchaseOrderItems: true } });
      if (!order || order.status === "CANCELLED") throw new HttpError(409, "Related purchase order is unavailable or cancelled.");
      const poDelta = new Map<string, number>();
      const variantChanges = new Map<string, { quantity: number; value: Prisma.Decimal; lines: { old: typeof receipt.purchaseReceiptItems[number]; next: typeof items[number]; quantity: number; value: Prisma.Decimal }[] }>();
      let totalAmount = receipt.totalAmount;
      for (const next of items) {
        const old = receipt.purchaseReceiptItems.find((item) => item.id === next.id);
        if (!old || !old.poItemId) throw new HttpError(400, "Receipt item does not belong to this receipt or has no PO line.");
        if (old.receivedQty !== next.expectedReceivedQty || !old.actualCost.eq(next.expectedActualCost)) throw new HttpError(409, "Receipt line changed since it was loaded. Reload before correcting.");
        const deltaQty = next.receivedQty - old.receivedQty;
        const deltaValue = next.actualCost.mul(next.receivedQty).minus(old.actualCost.mul(old.receivedQty));
        if (deltaQty === 0 && deltaValue.eq(0) && next.actualCost.eq(old.actualCost)) continue;
        poDelta.set(old.poItemId, (poDelta.get(old.poItemId) ?? 0) + deltaQty);
        const group = variantChanges.get(old.variantId) ?? { quantity: 0, value: new Prisma.Decimal(0), lines: [] };
        group.quantity += deltaQty; group.value = group.value.plus(deltaValue);
        group.lines.push({ old, next, quantity: deltaQty, value: deltaValue });
        variantChanges.set(old.variantId, group);
        totalAmount = totalAmount.plus(deltaValue);
      }
      money(totalAmount.toFixed(2), "totalAmount", 14);
      if (totalAmount.lt(receipt.paidAmount)) throw new HttpError(409, "Corrected total is below money already paid. Resolve payment/refund first.");
      for (const [poItemId, delta] of poDelta) {
        const item = order.purchaseOrderItems.find((row) => row.id === poItemId);
        if (!item || item.receivedQty + delta < 0 || item.receivedQty + delta > item.orderedQty) throw new HttpError(400, "Corrected quantity exceeds ordered quantity.");
      }
      for (const [variantId, group] of [...variantChanges].sort(([a], [b]) => a.localeCompare(b))) {
        const variant = await tx.productVariant.findFirst({ where: { id: variantId, businessId } });
        if (!variant || variant.isLockedForAudit) throw new HttpError(409, "SKU unavailable or locked for stock audit.");
        const latest = await tx.inventoryLedger.findFirst({ where: { businessId, variantId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        if (!latest || latest.referenceDocId !== id || !["PURCHASE_RECEIPT", "PURCHASE_RECEIPT_CORRECTION"].includes(latest.referenceDocType)) throw new HttpError(409, "SKU has subsequent stock movements. Direct correction requires a separate adjustment workflow.");
        const history = await tx.inventoryLedger.aggregate({ where: { businessId, variantId }, _sum: { quantityChanged: true } });
        const total = await tx.inventoryBalance.aggregate({ where: { businessId, variantId }, _sum: { quantityOnHand: true } });
        const onHand = total._sum.quantityOnHand ?? 0;
        const nextQuantity = onHand + group.quantity;
        if (onHand !== (history._sum.quantityChanged ?? 0) || nextQuantity < 0 || nextQuantity > 2_147_483_647) throw new HttpError(409, "Inventory no longer matches ledger or corrected stock is out of range.");
        const nextValue = variant.costPrice.mul(onHand).plus(group.value);
        if (nextValue.lt(0)) throw new HttpError(409, "Correction would create negative inventory value. A valuation adjustment is required.");
        const costPrice = nextQuantity > 0 ? nextValue.div(nextQuantity).toDecimalPlaces(2) : new Prisma.Decimal(0);
        money(costPrice.toFixed(2), "costPrice");
        let runningBalance = onHand;
        for (const change of group.lines) {
          const balance = await tx.inventoryBalance.findFirst({ where: { businessId, variantId, lotItemId: change.old.lotItemId } });
          if (!balance || balance.quantityOnHand + change.quantity < balance.damagedQuantity || balance.quantityOnHand + change.quantity > 2_147_483_647) throw new HttpError(409, "Insufficient available lot stock for correction.");
          await tx.inventoryBalance.update({ where: { id: balance.id }, data: { quantityOnHand: { increment: change.quantity }, updatedAt: new Date() } });
          runningBalance += change.quantity;
          if (runningBalance < 0 || runningBalance > 2_147_483_647) throw new HttpError(409, "Intermediate inventory balance is out of range.");
          await tx.purchaseReceiptItem.update({ where: { id: change.old.id }, data: { receivedQty: change.next.receivedQty, actualCost: change.next.actualCost } });
          await tx.inventoryLedger.create({ data: {
            businessId, variantId, lotItemId: change.old.lotItemId, createdBy,
            transactionType: change.quantity > 0 || (change.quantity === 0 && change.value.gte(0)) ? "STOCK_ADJUSTMENT_IN" : "STOCK_ADJUSTMENT_OUT",
            quantityChanged: change.quantity, balanceAfter: runningBalance,
            unitCost: change.next.actualCost, totalCostValue: change.value,
            referenceDocType: "PURCHASE_RECEIPT_CORRECTION", referenceDocId: id,
          } });
        }
        await tx.productVariant.update({ where: { id: variantId }, data: { costPrice, updatedAt: new Date() } });
      }
      for (const [poItemId, delta] of poDelta) await tx.purchaseOrderItem.update({ where: { id: poItemId }, data: { receivedQty: { increment: delta } } });
      const completed = order.purchaseOrderItems.every((item) => item.receivedQty + (poDelta.get(item.id) ?? 0) === item.orderedQty);
      const hasReceived = order.purchaseOrderItems.some((item) => item.receivedQty + (poDelta.get(item.id) ?? 0) > 0);
      const status = completed ? "COMPLETED" : order.status === "CLOSED_SHORT" ? "CLOSED_SHORT" : hasReceived ? "PARTIALLY_RECEIVED" : "ORDERED";
      await tx.purchaseOrder.update({ where: { id: order.id }, data: { status } });
      await changeDebt(tx, businessId, receipt.supplierId, totalAmount.minus(receipt.totalAmount));
      const result = await tx.purchaseReceipt.update({ where: { id }, data: { totalAmount }, include: { purchaseReceiptItems: true } });
      return { ...result, debtAmount: totalAmount.minus(receipt.paidAmount).toFixed(2) };
    });
  }
}

export const purchasesCorrectionService = new PurchasesCorrectionService();
