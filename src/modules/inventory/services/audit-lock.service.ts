import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../../shared/http/http-error";

class AuditLockService {
  /**
   * Validate that a variant is not locked for audit.
   * Throws 409 error if locked.
   */
  async validateNotLocked(businessId: string, variantId: string) {
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, businessId },
      select: { isLockedForAudit: true, sku: true },
    });

    if (!variant) {
      throw new HttpError(404, "SKU không tồn tại.");
    }

    if (variant.isLockedForAudit) {
      throw new HttpError(
        409,
        `Giao dịch bị chặn: SKU "${variant.sku}" đang bị khóa trong quá trình kiểm kê. Vui lòng chờ đến khi kiểm kê hoàn tất.`,
      );
    }
  }

  /**
   * Validate multiple variants are not locked for audit.
   * Throws 409 error if any are locked.
   */
  async validateNotLockedBatch(businessId: string, variantIds: string[]) {
    if (variantIds.length === 0) return;

    const lockedVariants = await prisma.productVariant.findMany({
      where: {
        id: { in: variantIds },
        businessId,
        isLockedForAudit: true,
      },
      select: { id: true, sku: true },
    });

    if (lockedVariants.length > 0) {
      const skus = lockedVariants.map((v) => `"${v.sku}"`).join(", ");
      throw new HttpError(
        409,
        `Giao dịch bị chặn: Các SKU ${skus} đang bị khóa trong quá trình kiểm kê. Vui lòng chờ đến khi kiểm kê hoàn tất.`,
      );
    }
  }

  /**
   * Get all audits currently locking this variant.
   */
  async getLockedAudits(businessId: string, variantId: string) {
    const audits = await prisma.stockAudit.findMany({
      where: {
        businessId,
        isLockedForAudit: true,
        status: { in: ["IN_PROGRESS", "PENDING_APPROVAL"] },
        stockAuditItems: {
          some: { variantId },
        },
      },
      select: {
        id: true,
        auditCode: true,
        status: true,
        countStartAt: true,
      },
    });

    return audits;
  }
}

export const auditLockService = new AuditLockService();
