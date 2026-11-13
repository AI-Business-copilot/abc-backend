import type { Prisma } from "@prisma/client";

import { HttpError } from "../../../shared/http/http-error";
import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { LotStatusService } from "./lot-status.service";
import { assertVariantNotLockedForAudit } from "./scrap-access";

type LotStatusName = "HEALTHY" | "WARNING" | "UNUSABLE" | "QUARANTINED" | "SCRAPPED";

/** Statuses the Owner needs to act on. HEALTHY and SCRAPPED are left out of the default expiry list. */
const DEFAULT_EXPIRING_STATUSES: LotStatusName[] = ["WARNING", "UNUSABLE", "QUARANTINED"];
const ALL_LOT_STATUSES: LotStatusName[] = ["HEALTHY", "WARNING", "UNUSABLE", "QUARANTINED", "SCRAPPED"];

export interface LotItemVariant {
  id: string;
  sku: string;
  template: { name: string };
}

/** Raw row shape shared by every query that returns a lot item with its status inputs. */
interface LotItemRow {
  id: string;
  variantId: string;
  manufacturingDate: Date | null;
  expirationDate: Date;
  status: string;
  quarantineQty: number | null;
  quarantinedAt: Date | null;
  lot: { id: string; lotNumber: string };
  variant: LotItemVariant;
  inventoryBalances: Array<{ quantityOnHand: number; damagedQuantity: number }>;
  scrapOrders: Array<{ id: string; scrapCode: string; status: string }>;
}

/** One variant inside a batch, with the status calculated for today. */
export interface LotItemWithStatus {
  id: string;
  lotId: string;
  lotNumber: string;
  variantId: string;
  manufacturingDate: Date | null;
  expirationDate: Date;
  dbStatus: string;
  calculatedStatus: string;
  effectiveStatus: string;
  daysUntilExpiry: number;
  quarantineQty: number | null;
  quarantinedAt: Date | null;
  variant: LotItemVariant;
  onHand: number;
  damaged: number;
  /**
   * The scrap order already raised for this lot item, in any status. A lot can only have one
   * scrap order, so the Owner and the staff both need to see which order is already there.
   */
  scrapOrder: { id: string; scrapCode: string; status: string } | null;
}

/** A batch header together with every variant it contains. */
export interface LotWithItems {
  id: string;
  lotNumber: string;
  createdAt: Date | null;
  items: LotItemWithStatus[];
}

/** A batch in the expiry list, holding only the variant items that matched the filter. */
export interface ExpiringLotBatch {
  id: string;
  lotNumber: string;
  items: LotItemWithStatus[];
}

export interface ExpiringLotsResult {
  lots: LotItemWithStatus[] | ExpiringLotBatch[];
  total: number;
  summary: Record<string, number>;
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

  /** Turn a lot item row into the API shape, adding the status calculated for today. */
  private toItemView(item: LotItemRow): LotItemWithStatus {
    return {
      id: item.id,
      lotId: item.lot.id,
      lotNumber: item.lot.lotNumber,
      variantId: item.variantId,
      manufacturingDate: item.manufacturingDate,
      expirationDate: item.expirationDate,
      dbStatus: item.status,
      calculatedStatus: this.lotStatusService.calculateStatus(item.expirationDate),
      effectiveStatus: this.lotStatusService.getEffectiveStatus(item.status, item.expirationDate),
      daysUntilExpiry: this.lotStatusService.getDaysUntilExpiry(item.expirationDate),
      quarantineQty: item.quarantineQty,
      quarantinedAt: item.quarantinedAt,
      variant: item.variant,
      onHand: item.inventoryBalances.reduce((sum, balance) => sum + balance.quantityOnHand, 0),
      damaged: item.inventoryBalances.reduce((sum, balance) => sum + balance.damagedQuantity, 0),
      scrapOrder: item.scrapOrders[0] ?? null,
    };
  }

  private itemSelect() {
    return {
      id: true,
      variantId: true,
      manufacturingDate: true,
      expirationDate: true,
      status: true,
      quarantineQty: true,
      quarantinedAt: true,
      lot: { select: { id: true, lotNumber: true } },
      variant: { select: { id: true, sku: true, template: { select: { name: true } } } },
      inventoryBalances: { select: { quantityOnHand: true, damagedQuantity: true } },
      // The newest scrap order of the lot, in any status: a lot can only have one.
      scrapOrders: {
        select: { id: true, scrapCode: true, status: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    } satisfies Prisma.ProductLotItemSelect;
  }

  /**
   * Initialize or recalculate statuses for all lot items in a business
   * Useful for batch updates or migrations
   * @param businessId The business ID
   * @returns Number of lot items updated
   */
  async initializeLotStatuses(businessId: string): Promise<number> {
    const items = await prisma.productLotItem.findMany({
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

    for (const item of items) {
      const newStatus = this.calculateLotStatus(item.expirationDate);
      await prisma.productLotItem.update({
        where: { id: item.id },
        data: { status: newStatus },
      });
      updatedCount++;
    }

    return updatedCount;
  }

  /**
   * Get all batches for a business, each with the variants it contains.
   * Filters apply to the items: a batch is kept only when at least one item matches.
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
  ): Promise<{ lots: LotWithItems[]; total: number }> {
    const take = filters?.take || 20;
    const skip = filters?.skip || 0;

    const where: Prisma.ProductLotWhereInput = { businessId };
    if (filters?.variantId) {
      where.items = { some: { variantId: filters.variantId } };
    }

    const rows = await prisma.productLot.findMany({
      where,
      select: {
        id: true,
        lotNumber: true,
        createdAt: true,
        items: { select: this.itemSelect() },
      },
    });

    // HEALTHY/WARNING/UNUSABLE are calculated from today's date, so status and day filters
    // are applied here rather than in the query.
    const status = filters?.status;
    const wantsStatus = Boolean(status && ALL_LOT_STATUSES.includes(status as LotStatusName));
    const hasDayRange = filters?.daysUntilMin !== undefined || filters?.daysUntilMax !== undefined;

    let lots: LotWithItems[] = rows.map((row) => ({
      id: row.id,
      lotNumber: row.lotNumber,
      createdAt: row.createdAt,
      items: row.items.map((item) => this.toItemView(item)),
    }));

    if (wantsStatus || hasDayRange) {
      lots = lots
        .map((lot) => ({
          ...lot,
          items: lot.items.filter((item) => {
            if (wantsStatus && item.effectiveStatus !== status) return false;
            if (
              filters?.daysUntilMin !== undefined &&
              item.daysUntilExpiry < filters.daysUntilMin
            ) {
              return false;
            }
            if (
              filters?.daysUntilMax !== undefined &&
              item.daysUntilExpiry > filters.daysUntilMax
            ) {
              return false;
            }
            return true;
          }),
        }))
        .filter((lot) => lot.items.length > 0);
    }

    // Batches are listed by the soonest expiry they contain, which is the order FEFO needs.
    const soonest = (lot: LotWithItems) =>
      Math.min(...lot.items.map((item) => item.expirationDate.getTime()));
    lots.sort((a, b) => soonest(a) - soonest(b));

    const total = lots.length;

    return {
      lots: lots.slice(skip, skip + take),
      total,
    };
  }

  /**
   * Get a single batch with all of its variant items
   */
  async getLot(businessId: string, lotId: string): Promise<LotWithItems> {
    const lot = await prisma.productLot.findUnique({
      where: { id: lotId },
      select: {
        id: true,
        businessId: true,
        lotNumber: true,
        createdAt: true,
        items: { select: this.itemSelect() },
      },
    });

    if (!lot || lot.businessId !== businessId) {
      throw new Error('Lot not found');
    }

    return {
      id: lot.id,
      lotNumber: lot.lotNumber,
      createdAt: lot.createdAt,
      items: lot.items.map((item) => this.toItemView(item)),
    };
  }

  /**
   * Load every lot item that passes the effective-status filter, with the per-status counts.
   * The effective status depends on today's date, so filtering happens in memory rather than in the query.
   */
  private async loadExpiringItems(
    businessId: string,
    status?: LotStatusName,
  ): Promise<{ matching: LotItemWithStatus[]; summary: Record<string, number> }> {
    const wanted: LotStatusName[] = status ? [status] : DEFAULT_EXPIRING_STATUSES;

    const rows = await prisma.productLotItem.findMany({
      // Only lot-tracked variants have meaningful expiry dates.
      where: { businessId, variant: { template: { hasLotTracking: true } } },
      select: this.itemSelect(),
      orderBy: { expirationDate: "asc" },
    });

    const allItems = rows.map((item) => this.toItemView(item));
    const matching = allItems.filter((item) => (wanted as string[]).includes(item.effectiveStatus));

    // The per-status counts cover every item, so they stay the same whichever tab is selected.
    // `total` is the size of the selected tab's list, the same as the top-level `total`.
    const summary: Record<string, number> = {
      healthy: 0,
      warning: 0,
      unusable: 0,
      quarantined: 0,
      scrapped: 0,
      total: matching.length,
    };
    for (const item of allItems) {
      summary[item.effectiveStatus.toLowerCase()]++;
    }

    return { matching, summary };
  }

  /**
   * Get lot items by status for expiry monitoring
   * Filters by calculated or database status.
   * Pass groupBy "lot" to page over batches instead of items: one row per lot number, each holding its variants.
   */
  async getExpiringLots(
    businessId: string,
    filters?: {
      status?: LotStatusName;
      groupBy?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<ExpiringLotsResult> {
    if (filters?.status && !ALL_LOT_STATUSES.includes(filters.status)) {
      throw new HttpError(400, `Invalid status. Use one of: ${ALL_LOT_STATUSES.join(", ")}.`);
    }

    const take = filters?.take || 20;
    const skip = filters?.skip || 0;
    const { matching, summary } = await this.loadExpiringItems(businessId, filters?.status);

    if (filters?.groupBy !== "lot") {
      return {
        lots: matching.slice(skip, skip + take),
        total: matching.length,
        summary,
      };
    }

    // Items arrive sorted by expiry, so each batch's items keep that order.
    const batches = new Map<string, ExpiringLotBatch>();
    for (const item of matching) {
      let batch = batches.get(item.lotId);
      if (!batch) {
        batch = { id: item.lotId, lotNumber: item.lotNumber, items: [] };
        batches.set(item.lotId, batch);
      }
      batch.items.push(item);
    }

    // Batches are listed by the soonest expiry they contain, which is the order FEFO needs.
    const grouped = [...batches.values()].sort(
      (a, b) =>
        Math.min(...a.items.map((item) => item.expirationDate.getTime())) -
        Math.min(...b.items.map((item) => item.expirationDate.getTime())),
    );

    return {
      lots: grouped.slice(skip, skip + take),
      total: grouped.length,
      summary,
    };
  }

  /**
   * Staff pull a quantity of one item off the shelf. Records how many, who and when.
   * quantity can be at most the item's on-hand plus damaged stock. No photo is taken here:
   * evidence belongs to the scrap order.
   */
  async quarantineLot(
    businessId: string,
    lotItemId: string,
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
      const item = await tx.productLotItem.findUnique({ where: { id: lotItemId } });
      if (!item || item.businessId !== businessId) {
        throw new HttpError(404, 'Lot item not found');
      }

      if (item.status === 'SCRAPPED') {
        throw new HttpError(409, 'A scrapped lot item cannot be quarantined.');
      }

      await assertVariantNotLockedForAudit(tx, businessId, item.variantId);

      const pending = await tx.scrapOrder.count({
        where: { businessId, lotItemId, status: 'PENDING' },
      });
      if (pending > 0) {
        throw new HttpError(
          409,
          'This lot item has a scrap order waiting for review. Resolve it before changing the quarantine.',
        );
      }

      const balances = await tx.inventoryBalance.aggregate({
        where: { businessId, lotItemId },
        _sum: { quantityOnHand: true, damagedQuantity: true },
      });
      const available = (balances._sum.quantityOnHand ?? 0) + (balances._sum.damagedQuantity ?? 0);

      if (quantity > available) {
        throw new HttpError(
          409,
          `Quarantine quantity ${quantity} is more than the ${available} unit(s) in this lot item.`,
        );
      }

      return tx.productLotItem.update({
        where: { id: lotItemId },
        data: {
          status: 'QUARANTINED',
          quarantineQty: quantity,
          quarantinedAt: new Date(),
          quarantinedBy: userId,
          quarantineNote: note,
        },
        include: {
          lot: { select: { id: true, lotNumber: true } },
          variant: { select: { id: true, sku: true, template: { select: { name: true } } } },
        },
      });
    });
  }

  /**
   * Find all UNUSABLE lot items that should trigger notifications
   */
  async getUnusableLots(businessId: string): Promise<LotItemWithStatus[]> {
    const { lots } = await this.getLots(businessId, {
      status: 'UNUSABLE',
    });

    return lots.flatMap((lot) => lot.items);
  }

  /**
   * Get lot item inventory summary (on-hand + damaged)
   */
  async getLotInventorySummary(
    businessId: string,
    lotItemId: string,
  ): Promise<{
    onHand: number;
    damaged: number;
    total: number;
  }> {
    const balances = await prisma.inventoryBalance.findMany({
      where: {
        businessId,
        lotItemId,
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
   * Hook for POS checkout: throws a 409 naming every lot item that cannot be sold
   * (UNUSABLE, QUARANTINED or SCRAPPED). Pass the checkout transaction as tx
   * so the check and the sale see the same data. Items from another business count as not found.
   */
  async assertLotItemsSellable(
    businessId: string,
    lotItemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const ids = [...new Set(lotItemIds)];
    if (ids.length === 0) return;

    const db = tx ?? prisma;
    const items = await db.productLotItem.findMany({
      where: { businessId, id: { in: ids } },
      select: {
        id: true,
        status: true,
        expirationDate: true,
        lot: { select: { lotNumber: true } },
        variant: { select: { sku: true } },
      },
    });

    const foundIds = new Set(items.map((item) => item.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new HttpError(404, `Lot item not found: ${missing.join(', ')}`);
    }

    const blocked = items
      .map((item) => ({
        item,
        verdict: this.canSellFromLot(item.status, item.expirationDate),
      }))
      .filter((entry) => !entry.verdict.allowed);

    if (blocked.length > 0) {
      const detail = blocked
        .map((entry) => `${entry.item.lot.lotNumber} / ${entry.item.variant.sku} (${entry.verdict.reason})`)
        .join('; ');
      throw new HttpError(409, `These lots cannot be sold: ${detail}`);
    }
  }
}
