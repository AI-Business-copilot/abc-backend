import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";

// Retry the whole operation so stock, payments and debt always commit together.
export async function atomic<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2034") throw error;
      if (attempt >= 2) throw new HttpError(409, "Concurrent inventory/payment update. Please retry.");
    }
  }
}

export async function actor(tx: Prisma.TransactionClient, authUserId: string) {
  const user = await tx.user.findUnique({ where: { authUserId } });
  if (!user?.isActive) throw new HttpError(403, "Active user required.");
  return user.id;
}

export async function supplierInBusiness(tx: Prisma.TransactionClient, businessId: string, id: string) {
  const supplier = await tx.supplier.findFirst({ where: { id, businessId } });
  if (!supplier) throw new HttpError(404, "Supplier not found in this business.");
  return supplier;
}

export async function changeDebt(tx: Prisma.TransactionClient, businessId: string, supplierId: string, delta: Prisma.Decimal) {
  const supplier = await supplierInBusiness(tx, businessId, supplierId);
  const debtAmount = new Prisma.Decimal(supplier.debtAmount ?? 0).plus(delta);
  if (debtAmount.abs().gte("10000000000")) throw new HttpError(400, "Supplier debt exceeds database precision.");
  await tx.supplier.update({ where: { id: supplier.id }, data: { debtAmount } });
}
