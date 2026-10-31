import { prisma } from "../shared/infrastructure/database/prisma.client";
import { LotStatusService } from "../modules/inventory/services/lot-status.service";

/**
 * Daily cron job to update lot statuses
 * Runs at 6 AM every day
 * Scans all lots and identifies those becoming UNUSABLE
 */
export async function updateLotStatusesCron() {
  try {
    const lotStatusService = new LotStatusService();

    const allLots = await prisma.productLot.findMany({
      select: {
        id: true,
        lotNumber: true,
        businessId: true,
        expirationDate: true,
        status: true,
        business: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    console.log(`Found ${allLots.length} lots to scan`);

    let unusableCount = 0;
    const today = new Date();

    for (const lot of allLots) {
      // Skip already scrapped or quarantined lots
      if ((lot.status as any) === 'SCRAPPED' || (lot.status as any) === 'QUARANTINED') {
        continue;
      }

      const isUnusable = lotStatusService.isUnusable(lot.expirationDate, today);

      if (isUnusable) {
        unusableCount++;

        // Optional: Create notification for owner
        // This could integrate with a notification service
        console.warn(
          `Lot ${lot.lotNumber} from business ${lot.businessId} is now UNUSABLE (expires ${lot.expirationDate.toDateString()})`,
        );
      }
    }

    console.log(
      `Cron job completed: ${allLots.length} lots scanned, ${unusableCount} are UNUSABLE`,
    );

    return {
      success: true,
      scannedCount: allLots.length,
      unusableCount,
      timestamp: new Date(),
    };
  } catch (err) {
    console.error('Error in updateLotStatusesCron', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      timestamp: new Date(),
    };
  }
}

/**
 * Cron job endpoint handler
 * Called by external scheduler (e.g., node-cron, AWS Lambda, etc.)
 */
export async function handleUpdateLotStatusesCron() {
  return updateLotStatusesCron();
}
