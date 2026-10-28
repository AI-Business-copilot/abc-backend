import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";
import { object, receiptInput } from "./purchases.input";
import { uuid } from "./purchases.query";
import { assertUsableLot, purchasesWriteService } from "./purchases-write.service";
import { orderFingerprint } from "./purchases-fingerprint";

function secret() {
  const key = process.env.PURCHASE_DRAFT_SECRET;
  if (!key || key.length < 32) throw new HttpError(503, "Configure PURCHASE_DRAFT_SECRET (at least 32 characters) to use receipt drafts.");
  return key;
}

type Draft = {
  version: 1; businessId: string; authUserId: string; orderId: string;
  orderFingerprint: string; expiresAt: number; receipt: Record<string, unknown>;
};

export function signDraft(draft: Draft) {
  const payload = Buffer.from(JSON.stringify(draft)).toString("base64url");
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  const token = `${payload}.${signature}`;
  if (token.length > 90_000) throw new HttpError(400, "Draft is too large. Split counting into smaller deliveries.");
  return token;
}

export function verifyDraft(value: unknown, businessId: string, authUserId: string, orderId: string, now = Date.now()): Draft {
  const key = secret();
  if (typeof value !== "string" || value.length > 90_000) throw new HttpError(400, "Invalid draft token.");
  const parts = value.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw new HttpError(400, "Invalid draft token.");
  const signature = Buffer.from(parts[1], "base64url");
  const expected = createHmac("sha256", key).update(parts[0]).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new HttpError(400, "Draft signature is invalid.");
  let draft: Draft;
  try { draft = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { throw new HttpError(400, "Invalid draft data."); }
  if (!draft || draft.version !== 1 || draft.businessId !== businessId || draft.authUserId !== authUserId || draft.orderId !== orderId) throw new HttpError(403, "Draft belongs to another user, business or purchase order.");
  if (!Number.isFinite(draft.expiresAt) || draft.expiresAt <= now) throw new HttpError(409, "Draft expired. Preview counting again.");
  return draft;
}

async function loadOrder(businessId: string, orderId: string) {
  const order = await prisma.purchaseOrder.findFirst({ where: { id: orderId, businessId }, include: { purchaseOrderItems: { orderBy: { id: "asc" } } } });
  if (!order) throw new HttpError(404, "Purchase order not found.");
  if (!["ORDERED", "PARTIALLY_RECEIVED"].includes(order.status)) throw new HttpError(409, "Purchase order is no longer open for receiving.");
  return order;
}

export class PurchasesDraftsService {
  async preview(businessId: string, authUserId: string, orderId: string, value: unknown) {
    secret();
    const id = uuid(orderId, "orderId");
    const body = object(value);
    const input = receiptInput(body);
    const order = await loadOrder(businessId, id);
    const variants = await prisma.productVariant.findMany({ where: { businessId, id: { in: order.purchaseOrderItems.map((item) => item.variantId) } }, include: { template: { select: { hasLotTracking: true } } } });
    const counts = new Map<string, number>();
    for (const line of input.items) {
      const poItem = order.purchaseOrderItems.find((item) => item.id === line.poItemId);
      if (!poItem) throw new HttpError(400, "Receipt line does not belong to this purchase order.");
      const count = (counts.get(poItem.id) ?? 0) + line.receivedQty;
      if (count + poItem.receivedQty > poItem.orderedQty) throw new HttpError(400, "Received quantity exceeds remaining ordered quantity.");
      counts.set(poItem.id, count);
      const variant = variants.find((item) => item.id === poItem.variantId);
      if (!variant?.isActive || variant.isLockedForAudit) throw new HttpError(409, "SKU inactive or locked for audit.");
      if (variant.template.hasLotTracking) {
        if (!line.lotNumber || !line.expirationDate) throw new HttpError(400, "Lot-tracked SKU requires lotNumber and expirationDate.");
        assertUsableLot(line.expirationDate);
      } else if (line.lotNumber || line.manufacturingDate || line.expirationDate) throw new HttpError(400, "SKU does not use lot tracking.");
    }
    const receipt = {
      receiptCode: input.receiptCode, paidAmount: input.paidAmount.toFixed(2),
      ...(body.shiftId === undefined ? {} : { shiftId: uuid(body.shiftId, "shiftId") }),
      items: input.items.map((item) => ({ ...item, actualCost: item.actualCost.toFixed(2), manufacturingDate: item.manufacturingDate?.toISOString().slice(0, 10), expirationDate: item.expirationDate?.toISOString().slice(0, 10) })),
    };
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const token = signDraft({ version: 1, businessId, authUserId, orderId: id, orderFingerprint: orderFingerprint(order), expiresAt, receipt });
    return { status: "DRAFT", persisted: false, draftToken: token, expiresAt: new Date(expiresAt).toISOString(), receipt, totalAmount: input.totalAmount.toFixed(2), debtAmount: input.totalAmount.minus(input.paidAmount).toFixed(2) };
  }

  async confirm(businessId: string, authUserId: string, orderId: string, value: unknown) {
    const id = uuid(orderId, "orderId");
    const draft = verifyDraft(object(value).draftToken, businessId, authUserId, id);
    // Compare the preview inside the same serializable transaction that receives stock.
    return purchasesWriteService.receiveOrder(businessId, authUserId, id, draft.receipt, draft.orderFingerprint);
  }
}

export const purchasesDraftsService = new PurchasesDraftsService();
