import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";
import { money, object } from "./purchases.input";
import { uuid } from "./purchases.query";
import { actor, atomic } from "./purchases-transaction";

export async function recordSupplierPayment(tx: Prisma.TransactionClient, businessId: string, userId: string, receiptId: string, amount: Prisma.Decimal, requestedShiftId?: unknown) {
  if (amount.eq(0)) return;
  money(amount.toFixed(2), "payment transaction amount");
  const shiftId = requestedShiftId === undefined ? undefined : uuid(requestedShiftId, "shiftId");
  const shift = await tx.cashShift.findFirst({ where: { id: shiftId, businessId, userId, status: "OPEN" }, orderBy: [{ openedAt: "desc" }, { id: "desc" }] });
  if (!shift) throw new HttpError(409, "Open a cash shift for this user before recording a supplier payment.");
  const lockedShift = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
      FROM "cash_shifts"
     WHERE "id" = ${shift.id}::uuid
       AND "business_id" = ${businessId}::uuid
       AND "user_id" = ${userId}::uuid
       AND "status" = 'OPEN'
     FOR UPDATE
  `;
  if (!lockedShift.length) throw new HttpError(409, "Open a cash shift for this user before recording a supplier payment.");
  await tx.cashTransaction.create({ data: {
    businessId, shiftId: shift.id, transactionType: "OUT", category: "SUPPLIER_PAYMENT",
    amount, refDocType: "PURCHASE_RECEIPT", refDocId: receiptId, createdBy: userId,
  } });
}

export class PurchasesPaymentsService {
  async openShift(businessId: string, authUserId: string, value: unknown) {
    const body = object(value);
    const openingCash = money(body.openingCash ?? 0, "openingCash");
    return atomic(async (tx) => {
      const userId = await actor(tx, authUserId);
      const existing = await tx.cashShift.findFirst({ where: { businessId, userId, status: "OPEN" } });
      if (existing) return existing;
      return tx.cashShift.create({ data: { businessId, userId, openingCash, status: "OPEN" } });
    });
  }

  async getOpenShift(businessId: string, authUserId: string) {
    const user = await prisma.user.findUnique({ where: { authUserId } });
    if (user?.status !== "ACTIVE") throw new HttpError(403, "Active user required.");
    return prisma.cashShift.findFirst({ where: { businessId, userId: user.id, status: "OPEN" }, orderBy: [{ openedAt: "desc" }, { id: "desc" }] });
  }

  async history(businessId: string, receiptId: string) {
    const id = uuid(receiptId, "receiptId");
    return prisma.$transaction(async (tx) => {
      const receipt = await tx.purchaseReceipt.findFirst({ where: { id, businessId } });
      if (!receipt) throw new HttpError(404, "Purchase receipt not found.");
      const items = await tx.cashTransaction.findMany({
        where: { businessId, refDocType: "PURCHASE_RECEIPT", refDocId: id, category: "SUPPLIER_PAYMENT", transactionType: "OUT" },
        include: { createdByUser: { select: { id: true, fullName: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const recorded = items.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
      return {
        receiptId: id, paidAmount: receipt.paidAmount.toFixed(2), recordedPaymentAmount: recorded.toFixed(2),
        untrackedPaidAmount: receipt.paidAmount.minus(recorded).toFixed(2),
        historyComplete: receipt.paidAmount.eq(recorded), items,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}

export const purchasesPaymentsService = new PurchasesPaymentsService();
