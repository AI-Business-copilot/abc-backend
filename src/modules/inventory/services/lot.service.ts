import type { Prisma } from "@prisma/client";

import { HttpError } from "../../../shared/http/http-error";
import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { LotStatusService } from "./lot-status.service";

type LotStatusName = "HEALTHY" | "WARNING" | "UNUSABLE" | "QUARANTINED" | "SCRAPPED";

/** Statuses the Owner needs to act on. HEALTHY and SCRAPPED are left out of the default expiry list. */
const DEFAULT_EXPIRING_STATUSES: LotStatusName[] = ["WARNING", "UNUSABLE", "QUARANTINED"];
const ALL_LOT_STATUSES: LotStatusName[] = ["HEALTHY", "WARNING", "UNUSABLE", "QUARANTINED", "SCRAPPED"];

export interface LotWithStatusVariant {
  id: string;
  sku: string;
  template: { name: string };
}

interface LotWithStatus {
  id: string;
  variantId: string;
  lotNumber: string;
  expirationDate: Date;
  dbStatus: string;
  calculatedStatus: string;
  effectiveStatus: string;
  daysUntilExpiry: number;
  quarantineQty?: number | null;
  quarantinedAt?: Date | null;
  variant: LotWithStatusVariant;
  inventoryBalances: Array<{
    quantityOnHand: number;
    damagedQuantity: number;
  }>;
}

export class LotService {
  constructor(private lotStatusService: LotStatusService) { }

  /**
   * Calculate lot status based on expiration date
   * Used to auto-set status when creating or updating lots
   * @param expirationDate The lot's expiration date
   * @returns Calculated status: HEALTHY, WARNING, or UNUSABLE
   */
  private calculateLotStatus(expirationDate: Date): string {
    return this.lotStatusService.calculateStatus(expirationDate);
  }

  /**
   * Initialize or recalculate statuses for all lots in a business
   * Useful for batch updates or migrations
   * @param businessId The business ID
   * @returns Number of lots updated
   */
  async initializeLotStatuses(businessId: string): Promise<number> {
    const lots = await prisma.productLot.findMany({
      where: {
        businessId,
        status: { notIn: ['QUARANTINED', 'SCRAPPED'] }, // Preserve manual QUARANTINED/SCRAPPED decisions
      },
      select: {
        id: true,
        expirationDate: true,
      },
    });

    let updatedCount = 0;

    for (const lot of lots) {
      const newStatus = this.calculateLotStatus(lot.expirationDate);
      await prisma.productLot.update({
        where: { id: lot.id },
        data: { status: newStatus },
      });
      updatedCount++;
    }

    return updatedCount;
  }

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
            template: { select: { name: true } },
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
      variant: lot.variant,
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
            template: { select: { name: true } },
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
      variant: lot.variant,
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
      status?: LotStatusName;
      skip?: number;
      take?: number;
    },
  ): Promise<{ lots: LotWithStatus[]; total: number; summary: Record<string, number> }> {
    if (filters?.status && !ALL_LOT_STATUSES.includes(filters.status)) {
      throw new HttpError(400, `Invalid status. Use one of: ${ALL_LOT_STATUSES.join(", ")}.`);
    }

    const take = filters?.take || 20;
    const skip = filters?.skip || 0;
    const wanted: LotStatusName[] = filters?.status ? [filters.status] : DEFAULT_EXPIRING_STATUSES;

    const rows = await prisma.productLot.findMany({
      // Only lot-tracked variants have meaningful expiry dates.
      where: { businessId, variant: { template: { hasLotTracking: true } } },
      select: {
        id: true,
        variantId: true,
        lotNumber: true,
        expirationDate: true,
        status: true,
        quarantineQty: true,
        quarantinedAt: true,
        variant: { select: { id: true, sku: true, template: { select: { name: true } } } },
        inventoryBalances: { select: { quantityOnHand: true, damagedQuantity: true } },
      },
      orderBy: { expirationDate: "asc" },
    });

    // The effective status depends on today's date, so it is calculated here and filtered before paging.
    const allLots = rows.map((lot) => ({
      id: lot.id,
      variantId: lot.variantId,
      lotNumber: lot.lotNumber,
      expirationDate: lot.expirationDate,
      dbStatus: lot.status,
      calculatedStatus: this.lotStatusService.calculateStatus(lot.expirationDate),
      effectiveStatus: this.lotStatusService.getEffectiveStatus(lot.status, lot.expirationDate),
      daysUntilExpiry: this.lotStatusService.getDaysUntilExpiry(lot.expirationDate),
      quarantineQty: lot.quarantineQty,
      quarantinedAt: lot.quarantinedAt,
      variant: lot.variant,
      inventoryBalances: lot.inventoryBalances,
    }));
    const matching = allLots.filter((lot) => (wanted as string[]).includes(lot.effectiveStatus));

    // The per-status counts cover every lot, so they stay the same whichever tab is selected.
    // `total` is the size of the selected tab's list, the same as the top-level `total`.
    const summary: Record<string, number> = {
      healthy: 0,
      warning: 0,
      unusable: 0,
      quarantined: 0,
      scrapped: 0,
      total: matching.length,
    };
    for (const lot of allLots) {
      summary[lot.effectiveStatus.toLowerCase()]++;
    }

    return {
      lots: matching.slice(skip, skip + take),
      total: matching.length,
      summary,
    };
  }

  /**
   * Staff pull a quantity of a lot off the shelf. Records how many, who and when.
   * quantity can be at most the lot's on-hand plus damaged stock. No photo is taken here:
   * evidence belongs to the scrap order.
   */
  async quarantineLot(
    businessId: string,
    lotId: string,
    userId: string,
    body: { quantity?: unknown; note?: unknown },
  ): Promise<any> {
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new HttpError(400, 'quantity must be a whole number greater than 0.');
    }

    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
    if (note && note.length > 500) {
      throw new HttpError(400, 'note must be 500 characters or fewer.');
    }

    return prisma.$transaction(async (tx) => {
      const lot = await tx.productLot.findUnique({ where: { id: lotId } });
      if (!lot || lot.businessId !== businessId) {
        throw new HttpError(404, 'Lot not found');
      }

      if (lot.status === 'SCRAPPED') {
        throw new HttpError(409, 'A scrapped lot cannot be quarantined.');
      }

      const pending = await tx.scrapOrder.count({
        where: { businessId, lotId, status: 'PENDING' },
      });
      if (pending > 0) {
        throw new HttpError(
          409,
          'This lot has a scrap order waiting for review. Resolve it before changing the quarantine.',
        );
      }

      const balances = await tx.inventoryBalance.aggregate({
        where: { businessId, lotId },
        _sum: { quantityOnHand: true, damagedQuantity: true },
      });
      const available = (balances._sum.quantityOnHand ?? 0) + (balances._sum.damagedQuantity ?? 0);

      if (quantity > available) {
        throw new HttpError(
          409,
          `Quarantine quantity ${quantity} is more than the ${available} unit(s) in this lot.`,
        );
      }

      return tx.productLot.update({
        where: { id: lotId },
        data: {
          status: 'QUARANTINED',
          quarantineQty: quantity,
          quarantinedAt: new Date(),
          quarantinedBy: userId,
          quarantineNote: note,
        },
        include: {
          variant: { select: { id: true, sku: true, template: { select: { name: true } } } },
        },
      });
    });
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

  /**
   * Hook for POS checkout: throws a 409 naming every lot that cannot be sold
   * (UNUSABLE, QUARANTINED or SCRAPPED). Pass the checkout transaction as tx
   * so the check and the sale see the same data. Lots from another business count as not found.
   */
  async assertLotsSellable(
    businessId: string,
    lotIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const ids = [...new Set(lotIds)];
    if (ids.length === 0) return;

    const db = tx ?? prisma;
    const lots = await db.productLot.findMany({
      where: { businessId, id: { in: ids } },
      select: { id: true, lotNumber: true, status: true, expirationDate: true },
    });

    const foundIds = new Set(lots.map((lot) => lot.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new HttpError(404, `Lot not found: ${missing.join(', ')}`);
    }

    const blocked = lots
      .map((lot) => ({
        lot,
        verdict: this.canSellFromLot(lot.status, lot.expirationDate),
      }))
      .filter((entry) => !entry.verdict.allowed);

    if (blocked.length > 0) {
      const detail = blocked
        .map((entry) => `${entry.lot.lotNumber} (${entry.verdict.reason})`)
        .join('; ');
      throw new HttpError(409, `These lots cannot be sold: ${detail}`);
    }
  }
}
