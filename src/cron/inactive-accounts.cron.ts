import { prisma } from "../shared/infrastructure/database/prisma.client";

/**
 * Tự động rà soát và vô hiệu hóa các tài khoản không hoạt động > 180 ngày
 */
export async function cleanupInactiveAccounts(inactiveDays = 180) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - inactiveDays);

  const result = await prisma.user.updateMany({
    where: {
      status: "ACTIVE",
      createdAt: { lt: cutoffDate },
      // Chưa từng có giao dịch hoặc phiên làm việc trong 180 ngày qua
      inventoryLedger: { none: { createdAt: { gte: cutoffDate } } },
      openingStockSheets: { none: { createdAt: { gte: cutoffDate } } },
    },
    data: {
      status: "INACTIVE",
    },
  });

  return {
    scanned: true,
    deactivatedCount: result.count,
    cutoffDate,
  };
}

