import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { LotStatusService } from "./lot-status.service";

interface LotWithStatus {
  id: string;
  variantId: string;
  lotNumber: string;
  expirationDate: Date;
  dbStatus: string;
  calculatedStatus: string;
  effectiveStatus: string;
  daysUntilExpiry: number;
  variant: {
    id: string;
    sku: string;
    name: string;
    template?: {
      name: string;
    };
  };
  inventoryBalances: Array<{
    quantityOnHand: number;
    damagedQuantity: number;
  }>;
}

export class LotService {
  constructor(private lotStatusService: LotStatusService) { }

  /**
   * Get all lots for a business with status information
   */
  async getLots(
    businessId: string,
    filters?: {
      status?: string;
      variantId?: string;
      daysUntilMin?: number;
      daysUntilMax?: number;
      skip?: number;
      take?: number;
    },
  ): Promise<{ lots: LotWithStatus[]; total: number }> {
    const take = filters?.take || 20;
    const skip = filters?.skip || 0;

    // Build where clause
    const where: any = {
      businessId,
    };

    if (filters?.variantId) {
      where.variantId = filters.variantId;
    }

    // Note: HEALTHY/WARNING/UNUSABLE are calculated statuses
    // QUARANTINED and SCRAPPED are database statuses
    // We'll filter those post-query if needed

    const allLots = await prisma.productLot.findMany({
      where,
      select: {
        id: true,
        variantId: true,
        lotNumber: true,
        expirationDate: true,
        status: true,
        variant: {
          select: {
            id: true,
            sku: true,
            template: {
              select: {
                name: true,
              },
            },
          },
        },
        inventoryBalances: {
          select: {
            quantityOnHand: true,
            damagedQuantity: true,
          },
        },
      },
      orderBy: {
        expirationDate: 'asc',
      },
    });

    // Calculate effective status for each lot
    const lotsWithStatus = allLots.map((lot) => ({
      id: lot.id,
      variantId: lot.variantId,
      lotNumber: lot.lotNumber,
      expirationDate: lot.expirationDate,
      dbStatus: lot.status,
      calculatedStatus: this.lotStatusService.calculateStatus(
        lot.expirationDate,
      ),
      effectiveStatus: this.lotStatusService.getEffectiveStatus(
        lot.status,
        lot.expirationDate,
      ),
      daysUntilExpiry: this.lotStatusService.getDaysUntilExpiry(
        lot.expirationDate,
      ),
      variant: {
        id: lot.variant.id,
        sku: lot.variant.sku,
        name: lot.variant.template?.name || '',
        template: lot.variant.template,
      },
      inventoryBalances: lot.inventoryBalances,
    }));

    // Apply day range filter if provided (post-calculation)
    let filtered = lotsWithStatus;
    if (
      filters?.daysUntilMin !== undefined ||
      filters?.daysUntilMax !== undefined
    ) {
      filtered = lotsWithStatus.filter((lot) => {
        if (
          filters.daysUntilMin !== undefined &&
          lot.daysUntilExpiry < filters.daysUntilMin
        ) {
          return false;
        }
        if (
          filters.daysUntilMax !== undefined &&
          lot.daysUntilExpiry > filters.daysUntilMax
        ) {
          return false;
        }
        return true;
      });
    }

    // Apply status filter (calculated statuses)
    if (
      filters?.status &&
      ['HEALTHY', 'WARNING', 'UNUSABLE'].includes(filters.status)
    ) {
      filtered = filtered.filter(
        (lot) => lot.effectiveStatus === filters.status,
      );
    }

    const total = filtered.length;
    const paginated = filtered.slice(skip, skip + take);

    return {
      lots: paginated,
      total,
    };
  }

  /**
   * Get a single lot with status information
   */
  async getLot(businessId: string, lotId: string): Promise<LotWithStatus> {
    const lot = await prisma.productLot.findUnique({
      where: { id: lotId },
      select: {
        id: true,
        businessId: true,
        variantId: true,
        lotNumber: true,
        expirationDate: true,
        status: true,
        variant: {
          select: {
            id: true,
            sku: true,
            template: {
              select: {
                name: true,
              },
            },
          },
        },
        inventoryBalances: {
          select: {
            quantityOnHand: true,
            damagedQuantity: true,
          },
        },
      },
    });

    if (!lot || lot.businessId !== businessId) {
      throw new Error('Lot not found');
    }

    const daysUntilExpiry = this.lotStatusService.getDaysUntilExpiry(
      lot.expirationDate,
    );

    return {
      id: lot.id,
      variantId: lot.variantId,
      lotNumber: lot.lotNumber,
      expirationDate: lot.expirationDate,
      dbStatus: lot.status,
      calculatedStatus: this.lotStatusService.calculateStatus(
        lot.expirationDate,
      ),
      effectiveStatus: this.lotStatusService.getEffectiveStatus(
        lot.status,
        lot.expirationDate,
      ),
      daysUntilExpiry,
      variant: {
        id: lot.variant.id,
        sku: lot.variant.sku,
        name: lot.variant.template?.name || '',
        template: lot.variant.template,
      },
      inventoryBalances: lot.inventoryBalances,
    };
  }

  /**
   * Get lots by status for expiry monitoring
   * Filters by calculated or database status
   */
  async getExpiringLots(
    businessId: string,
    filters?: {
      status?: 'HEALTHY' | 'WARNING' | 'UNUSABLE' | 'QUARANTINED' | 'SCRAPPED';
      skip?: number;
      take?: number;
    },
  ): Promise<{ lots: LotWithStatus[]; summary: Record<string, number> }> {
    const { lots, total } = await this.getLots(businessId, {
      ...filters,
    });

    // Build summary
    const summary: Record<string, number> = {
      healthy: 0,
      warning: 0,
      unusable: 0,
      quarantined: 0,
      scrapped: 0,
      total,
    };

    lots.forEach((lot) => {
      const status = lot.effectiveStatus.toLowerCase();
      if (status in summary) {
        summary[status]++;
      }
    });

    return {
      lots,
      summary,
    };
  }

  /**
   * Mark a lot as QUARANTINED (staff removes from shelf)
   */
  async quarantineLot(businessId: string, lotId: string): Promise<any> {
    const lot = await prisma.productLot.findUnique({
      where: { id: lotId },
    });

    if (!lot || lot.businessId !== businessId) {
      throw new Error('Lot not found');
    }

    if ((lot as any).status !== 'ACTIVE') {
      throw new Error(
        `Cannot quarantine lot with status ${(lot as any).status}. Only ACTIVE lots can be quarantined.`,
      );
    }

    const updated = await prisma.productLot.update({
      where: { id: lotId },
      data: {
        status: 'QUARANTINED',
      },
      include: {
        variant: {
          select: {
            id: true,
            sku: true,
            template: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });

    return {
      ...updated,
      variant: {
        id: updated.variant.id,
        sku: updated.variant.sku,
        name: updated.variant.template?.name || '',
        template: updated.variant.template,
      },
    };
  }

  /**
   * Find all UNUSABLE lots that should trigger notifications
   */
  async getUnusableLots(businessId: string): Promise<LotWithStatus[]> {
    const { lots } = await this.getLots(businessId, {
      status: 'UNUSABLE',
    });

    return lots;
  }

  /**
   * Cron job: Update lot statuses daily
   * Scans all lots and identifies those becoming UNUSABLE
   */
  async updateLotStatusesCron(): Promise<{
    scannedCount: number;
    unusableCount: number;
  }> {
    const activeLots = await prisma.productLot.findMany({
      // Query all lots - status filtering handled in cron file
      select: {
        id: true,
        expirationDate: true,
      },
    });

    let unusableCount = 0;

    for (const lot of activeLots) {
      const isUnusable = this.lotStatusService.isUnusable(lot.expirationDate);
      if (isUnusable) {
        // Optional: could create a notification here
        // For now, just count them
        unusableCount++;
      }
    }

    return {
      scannedCount: activeLots.length,
      unusableCount,
    };
  }

  /**
   * Get lot inventory summary (on-hand + damaged)
   */
  async getLotInventorySummary(
    businessId: string,
    lotId: string,
  ): Promise<{
    onHand: number;
    damaged: number;
    total: number;
  }> {
    const balances = await prisma.inventoryBalance.findMany({
      where: {
        businessId,
        lotId,
      },
    });

    const onHand = balances.reduce((sum, b) => sum + b.quantityOnHand, 0);
    const damaged = balances.reduce((sum, b) => sum + b.damagedQuantity, 0);

    return {
      onHand,
      damaged,
      total: onHand + damaged,
    };
  }

  /**
   * Check if lot can be used for sales (FEFO validation)
   */
  canSellFromLot(
    dbStatus: string,
    expirationDate: Date,
  ): { allowed: boolean; reason?: string } {
    const effectiveStatus = this.lotStatusService.getEffectiveStatus(
      dbStatus,
      expirationDate,
    );

    if (effectiveStatus === 'SCRAPPED') {
      return { allowed: false, reason: 'Lot has been scrapped' };
    }

    if (effectiveStatus === 'QUARANTINED') {
      return { allowed: false, reason: 'Lot is in quarantine' };
    }

    if (effectiveStatus === 'UNUSABLE') {
      return { allowed: false, reason: 'Lot is expired or near expiry' };
    }

    return { allowed: true };
  }
}
