import { createHash } from "node:crypto";
import type { PurchaseOrder, PurchaseOrderItem } from "@prisma/client";

type OrderSnapshot = Pick<PurchaseOrder, "id" | "supplierId" | "poCode" | "status" | "orderDate" | "expectedDeliveryDate"> & {
  purchaseOrderItems: Pick<PurchaseOrderItem, "id" | "variantId" | "orderedQty" | "receivedQty" | "unitPrice">[];
};

export function orderFingerprint(order: OrderSnapshot) {
  return createHash("sha256").update(JSON.stringify({
    id: order.id, supplierId: order.supplierId, poCode: order.poCode,
    status: order.status, orderDate: order.orderDate, expectedDeliveryDate: order.expectedDeliveryDate,
    items: [...order.purchaseOrderItems].sort((a, b) => a.id.localeCompare(b.id)).map((item) => [item.id, item.variantId, item.orderedQty, item.receivedQty, item.unitPrice.toFixed(2)]),
  })).digest("hex");
}
