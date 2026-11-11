import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { HttpError } from "../../../shared/http/http-error";
import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { deleteObjects, uploadObject } from "../../../shared/infrastructure/storage/supabase-storage";
import { LotStatusService } from "./lot-status.service";
import { ScrapImageService, type ScrapImageDto } from "./scrap-image.service";
import {
  assertOwner,
  assertStaff,
  assertUuid,
  assertVariantNotLockedForAudit,
  lockScrapOrder,
  lotStatusLabel,
  scrapStatusLabel,
  type ScrapActor,
} from "./scrap-access";

export const REJECTION_REASON_CODES = [
  "WRONG_QUANTITY",
  "PHOTO_UNCLEAR",
  "NOT_REMOVED_FROM_SHELF",
  "OTHER",
] as const;

type ScrapSource = "DAMAGED_STOCK" | "SELLABLE_STOCK";

const userSelect = { select: { id: true, fullName: true, email: true } } as const;

const orderInclude = {
  variant: { select: { id: true, sku: true, costPrice: true, template: { select: { name: true } } } },
  lotItem: {
    select: {
      id: true,
      expirationDate: true,
      status: true,
      quarantineQty: true,
      lot: { select: { id: true, lotNumber: true } },
    },
  },
  createdByUser: userSelect,
  approvedByUser: userSelect,
  rejectedByUser: userSelect,
  cancelledByUser: userSelect,
} satisfies Prisma.ScrapOrderInclude;

const lotStatusService = new LotStatusService();
const imageService = new ScrapImageService();

function formatScrapOrder<T extends { variant?: any } | null>(order: T): T {
  if (!order || !order.variant) return order;
  return {
    ...order,
    variant: {
      ...order.variant,
      name: order.variant.template?.name ?? '',
    },
  };
}

function parseQuantity(value: unknown, label: string): number {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new HttpError(400, `${label} must be a whole number greater than 0.`);
  }
  return quantity;
}

function parseReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "scrapReason is required.");
  }
  const reason = value.trim();
  if (reason.length > 255) {
    throw new HttpError(400, "scrapReason must be 255 characters or fewer.");
  }
  return reason;
}

export class ScrapService {
  /** Next code like SCRAP-2026-00001 for the business. */
  private async generateScrapCode(businessId: string): Promise<string> {
    const prefix = `SCRAP-${new Date().getFullYear()}`;
    const last = await prisma.scrapOrder.findFirst({
      where: { businessId, scrapCode: { startsWith: prefix } },
      orderBy: { scrapCode: "desc" },
      select: { scrapCode: true },
    });
    const lastSequence = last ? parseInt(last.scrapCode.split("-")[2], 10) || 0 : 0;
    return `${prefix}-${String(lastSequence + 1).padStart(5, "0")}`;
  }

  private async availableFor(
    db: Prisma.TransactionClient | typeof prisma,
    businessId: string,
    variantId: string,
    lotItemId: string,
    source: ScrapSource,
  ) {
    const balance = await db.inventoryBalance.findFirst({ where: { businessId, variantId, lotItemId } });
    if (!balance) {
      throw new HttpError(409, "No inventory balance found for this lot item.");
    }
    const available = source === "DAMAGED_STOCK" ? balance.damagedQuantity : balance.quantityOnHand;
    return { balance, available };
  }

  /**
   * STAFF only. The lot item must be QUARANTINED and have no other PENDING scrap order.
   * Needs 1 to 10 evidence photos, which are saved with the order and cannot be changed afterward.
   */
  async createScrapOrder(
    businessId: string,
    actor: ScrapActor,
    data: {
      lotItemId?: unknown;
      variantId?: unknown;
      scrapQty?: unknown;
      scrapSource?: unknown;
      scrapReason?: unknown;
    },
    files: { buffer: Buffer }[] | undefined,
  ) {
    assertStaff(actor);
    const lotItemId = assertUuid(data.lotItemId, "Lot item");
    const scrapReason = parseReason(data.scrapReason);
    const images = imageService.prepareImages(files);

    const lotItem = await prisma.productLotItem.findFirst({
      where: { id: lotItemId, businessId },
      include: { variant: { select: { costPrice: true, isLockedForAudit: true } } },
    });
    if (!lotItem) {
      throw new HttpError(404, "Lot item not found");
    }
    if (lotItem.variant.isLockedForAudit) {
      throw new HttpError(409, "This SKU is locked for a stock audit. Finish the count before scrapping its stock.");
    }
    if (data.variantId !== undefined && data.variantId !== lotItem.variantId) {
      throw new HttpError(400, "variantId does not match this lot item.");
    }
    if (lotItem.status !== "QUARANTINED") {
      throw new HttpError(409, "Only a quarantined lot item can be scrapped. Quarantine it first.");
    }

    const scrapQty =
      data.scrapQty === undefined || data.scrapQty === null
        ? lotItem.quarantineQty
        : parseQuantity(data.scrapQty, "scrapQty");
    if (!scrapQty || scrapQty <= 0) {
      throw new HttpError(400, "scrapQty is required because this lot item has no recorded quarantine quantity.");
    }
    if (lotItem.quarantineQty && scrapQty > lotItem.quarantineQty) {
      throw new HttpError(409, `scrapQty ${scrapQty} is more than the ${lotItem.quarantineQty} unit(s) quarantined.`);
    }

    let scrapSource: ScrapSource;
    if (data.scrapSource === undefined || data.scrapSource === null) {
      const balance = await prisma.inventoryBalance.findFirst({
        where: { businessId, variantId: lotItem.variantId, lotItemId },
      });
      scrapSource = balance && balance.quantityOnHand >= scrapQty ? "SELLABLE_STOCK" : "DAMAGED_STOCK";
    } else if (data.scrapSource === "DAMAGED_STOCK" || data.scrapSource === "SELLABLE_STOCK") {
      scrapSource = data.scrapSource;
    } else {
      throw new HttpError(400, "scrapSource must be DAMAGED_STOCK or SELLABLE_STOCK.");
    }

    const { available } = await this.availableFor(prisma, businessId, lotItem.variantId, lotItemId, scrapSource);
    if (available < scrapQty) {
      throw new HttpError(
        409,
        `Insufficient ${scrapSource === "DAMAGED_STOCK" ? "damaged" : "sellable"} quantity. Available: ${available}, requested: ${scrapQty}.`,
      );
    }

    // Cheap check before touching Storage. The loop below checks again in case of a race.
    const existingOrder = await prisma.scrapOrder.findFirst({
      where: { businessId, lotItemId },
      orderBy: { createdAt: "desc" },
      select: { scrapCode: true, status: true },
    });
    if (existingOrder) {
      throw new HttpError(
        409,
        `This lot item already has a scrap order (${existingOrder.scrapCode}, ${scrapStatusLabel(existingOrder.status)}). ` +
          `A lot can only have one scrap order; settle the existing order before creating another.`,
      );
    }

    // The photos are stored with the order and never change afterward, so they are written in the same step.
    const orderId = randomUUID();
    const storedImages = images.map((image) => ({
      ...image,
      storagePath: `${businessId}/scrap-orders/${orderId}/${randomUUID()}.${image.extension}`,
    }));
    const uploadedPaths: string[] = [];

    try {
      for (const image of storedImages) {
        await uploadObject(image.storagePath, image.buffer, image.mimeType);
        uploadedPaths.push(image.storagePath);
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        const existing = await prisma.scrapOrder.findFirst({
          where: { businessId, lotItemId },
          orderBy: { createdAt: "desc" },
          select: { scrapCode: true, status: true },
        });
        if (existing) {
          throw new HttpError(
            409,
            `This lot item already has a scrap order (${existing.scrapCode}, ${scrapStatusLabel(existing.status)}). ` +
              `A lot can only have one scrap order; settle the existing order before creating another.`,
          );
        }

        try {
          // One nested create: the order and its photos are saved together or not at all.
          const created = await prisma.scrapOrder.create({
            data: {
              id: orderId,
              businessId,
              scrapCode: await this.generateScrapCode(businessId),
              variantId: lotItem.variantId,
              lotItemId,
              scrapQty,
              unitCost: lotItem.variant.costPrice,
              scrapSource,
              scrapReason,
              status: "PENDING",
              createdBy: actor.userId,
              images: {
                create: storedImages.map((image) => ({
                  businessId,
                  storagePath: image.storagePath,
                  mimeType: image.mimeType,
                  sizeBytes: image.buffer.length,
                  uploadedBy: actor.userId,
                })),
              },
            },
            include: orderInclude,
          });
          return formatScrapOrder(created);
        } catch (error) {
          // P2002 is either a duplicate scrap code (retry with a fresh one) or the one-PENDING-per-lot-item index.
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
            throw error;
          }
        }
      }
      throw new HttpError(409, "The scrap order could not be created. Try again.");
    } catch (error) {
      // Nothing was saved, so the files already in Storage would be orphans.
      await deleteObjects(uploadedPaths);
      throw error;
    }
  }

  async getScrapOrders(
    businessId: string,
    filters?: {
      status?: string;
      scrapSource?: string;
      startDate?: Date;
      endDate?: Date;
      skip?: number;
      take?: number;
    },
  ) {
    const take = filters?.take || 20;
    const skip = filters?.skip || 0;

    const where: Prisma.ScrapOrderWhereInput = { businessId };
    if (filters?.status) where.status = filters.status;
    if (filters?.scrapSource) where.scrapSource = filters.scrapSource;
    if (filters?.startDate || filters?.endDate) {
      where.createdAt = {
        ...(filters.startDate ? { gte: filters.startDate } : {}),
        ...(filters.endDate ? { lte: filters.endDate } : {}),
      };
    }

    const [orders, total] = await Promise.all([
      prisma.scrapOrder.findMany({
        where,
        include: {
          ...orderInclude,
          _count: { select: { images: { where: { deletedAt: null } } } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.scrapOrder.count({ where }),
    ]);

    return { orders: orders.map(formatScrapOrder), total };
  }

  /** One order with its non-deleted photos as 5-minute signed links, so the Owner can review it. */
  async getScrapOrder(businessId: string, scrapOrderId: string) {
    assertUuid(scrapOrderId, "Scrap order");
    const order = await prisma.scrapOrder.findFirst({
      where: { id: scrapOrderId, businessId },
      include: orderInclude,
    });
    if (!order) {
      throw new HttpError(404, "Scrap order not found");
    }
    const images: ScrapImageDto[] = await imageService.listImagesForOrder(businessId, scrapOrderId);
    return formatScrapOrder({ ...order, images });
  }

  /** Only the STAFF member who created the order, and only while it is PENDING. */
  async updateScrapOrder(
    businessId: string,
    actor: ScrapActor,
    scrapOrderId: string,
    data: { scrapQty?: unknown; scrapReason?: unknown },
  ) {
    assertStaff(actor);
    assertUuid(scrapOrderId, "Scrap order");

    const update: Prisma.ScrapOrderUpdateInput = {};
    if (data.scrapReason !== undefined) update.scrapReason = parseReason(data.scrapReason);
    const newQty = data.scrapQty !== undefined ? parseQuantity(data.scrapQty, "scrapQty") : undefined;
    if (newQty !== undefined) update.scrapQty = newQty;
    if (Object.keys(update).length === 0) {
      throw new HttpError(400, "Send scrapQty or scrapReason to update.");
    }

    return prisma.$transaction(async (tx) => {
      const locked = await lockScrapOrder(tx, businessId, scrapOrderId);
      if (locked.created_by !== actor.userId) {
        throw new HttpError(403, "Only the staff member who created this scrap order can change it.");
      }
      if (locked.status !== "PENDING") {
        throw new HttpError(409, `Phiếu hủy đang ${scrapStatusLabel(locked.status)} không thể được sửa.`);
      }

      if (newQty !== undefined) {
        const order = await tx.scrapOrder.findFirstOrThrow({
          where: { id: scrapOrderId, businessId },
          include: { lotItem: { select: { quarantineQty: true } } },
        });
        if (order.lotItem?.quarantineQty && newQty > order.lotItem.quarantineQty) {
          throw new HttpError(409, `scrapQty ${newQty} is more than the ${order.lotItem.quarantineQty} unit(s) quarantined.`);
        }
        if (!order.lotItemId) {
          throw new HttpError(409, "This scrap order has no lot item.");
        }
        const { available } = await this.availableFor(
          tx,
          businessId,
          order.variantId,
          order.lotItemId,
          order.scrapSource as ScrapSource,
        );
        if (available < newQty) {
          throw new HttpError(409, `Insufficient quantity available. Available: ${available}, requested: ${newQty}.`);
        }
      }

      const updated = await tx.scrapOrder.update({ where: { id: scrapOrderId }, data: update, include: orderInclude });
      return formatScrapOrder(updated);
    });
  }

  /** Only the creating STAFF member, only while PENDING. Removes the order, its photo rows and the stored files. */
  async deleteScrapOrder(businessId: string, actor: ScrapActor, scrapOrderId: string): Promise<void> {
    assertStaff(actor);
    assertUuid(scrapOrderId, "Scrap order");

    const paths = await prisma.$transaction(async (tx) => {
      const locked = await lockScrapOrder(tx, businessId, scrapOrderId);
      if (locked.created_by !== actor.userId) {
        throw new HttpError(403, "Only the staff member who created this scrap order can delete it.");
      }
      if (locked.status !== "PENDING") {
        throw new HttpError(409, `Phiếu hủy đang ${scrapStatusLabel(locked.status)} không thể bị xoá.`);
      }

      // Includes soft-deleted photos: once the order is gone nothing refers to their files.
      const images = await tx.scrapOrderImage.findMany({
        where: { businessId, scrapOrderId },
        select: { storagePath: true },
      });
      await tx.scrapOrder.delete({ where: { id: scrapOrderId } });
      return images.map((image) => image.storagePath);
    });

    // After commit and best effort: a storage hiccup must not undo the delete.
    await deleteObjects(paths);
  }

  /**
   * Owner only. Atomic: checks the photos the Owner saw, reduces stock, writes the ledger row and
   * completes the order. The order row stays locked, so photos cannot change during the approval.
   */
  async approveScrapOrder(
    businessId: string,
    actor: ScrapActor,
    scrapOrderId: string,
    body: { reviewedImageIds?: unknown },
  ) {
    assertOwner(actor);
    assertUuid(scrapOrderId, "Scrap order");

    if (!Array.isArray(body.reviewedImageIds) || body.reviewedImageIds.some((id) => typeof id !== "string")) {
      throw new HttpError(400, "reviewedImageIds must be a list of the photo ids you reviewed.");
    }
    const reviewed = new Set(body.reviewedImageIds as string[]);

    const result = await prisma.$transaction(async (tx) => {
      const locked = await lockScrapOrder(tx, businessId, scrapOrderId);
      if (locked.status !== "PENDING") {
        throw new HttpError(409, `Phiếu hủy đang ${scrapStatusLabel(locked.status)} không thể được duyệt.`);
      }

      const images = await tx.scrapOrderImage.findMany({
        where: { businessId, scrapOrderId, deletedAt: null },
        select: { id: true },
      });
      if (images.length === 0) {
        throw new HttpError(409, "This scrap order has no photos. Reject it or ask staff to add photos.");
      }
      const current = new Set(images.map((image) => image.id));
      const same = current.size === reviewed.size && [...current].every((id) => reviewed.has(id));
      if (!same) {
        throw new HttpError(409, "The photos changed since you reviewed them. Open the order again and review them.");
      }

      const order = await tx.scrapOrder.findFirstOrThrow({ where: { id: scrapOrderId, businessId } });
      if (!order.lotItemId) {
        throw new HttpError(409, "This scrap order has no lot item.");
      }
      const lotItem = await tx.productLotItem.findFirstOrThrow({ where: { id: order.lotItemId, businessId } });
      if (lotItem.status !== "QUARANTINED") {
        throw new HttpError(
          409,
          `Lô hàng đang ${lotStatusLabel(lotItem.status)}, không phải đang cách ly, nên không thể hủy hàng.`,
        );
      }
      await assertVariantNotLockedForAudit(tx, businessId, order.variantId);

      const source = order.scrapSource as ScrapSource;
      const { balance } = await this.availableFor(tx, businessId, order.variantId, order.lotItemId, source);

      // Conditional decrement: if stock changed meanwhile this matches no row and the approval stops.
      const reduced = await tx.inventoryBalance.updateMany({
        where:
          source === "DAMAGED_STOCK"
            ? { id: balance.id, damagedQuantity: { gte: order.scrapQty } }
            : { id: balance.id, quantityOnHand: { gte: order.scrapQty } },
        data:
          source === "DAMAGED_STOCK"
            ? { damagedQuantity: { decrement: order.scrapQty }, updatedAt: new Date() }
            : { quantityOnHand: { decrement: order.scrapQty }, updatedAt: new Date() },
      });
      if (reduced.count === 0) {
        throw new HttpError(409, "There is not enough stock left to scrap this quantity.");
      }

      // balanceAfter follows the other ledger writers: the variant's total on hand across lots.
      const variantTotal = await tx.inventoryBalance.aggregate({
        where: { businessId, variantId: order.variantId },
        _sum: { quantityOnHand: true },
      });
      const totalCost = new Prisma.Decimal(order.unitCost).mul(order.scrapQty);
      await tx.inventoryLedger.create({
        data: {
          businessId,
          variantId: order.variantId,
          lotItemId: order.lotItemId,
          transactionType: "SCRAP_DISPOSAL",
          quantityChanged: -order.scrapQty,
          balanceAfter: variantTotal._sum.quantityOnHand ?? 0,
          unitCost: order.unitCost,
          totalCostValue: totalCost,
          referenceDocType: "SCRAP_ORDER",
          referenceDocId: scrapOrderId,
          createdBy: actor.userId,
        },
      });

      // The lot item is SCRAPPED only when nothing is left on it; otherwise it keeps what is still quarantined.
      const lotStock = await tx.inventoryBalance.aggregate({
        where: { businessId, lotItemId: order.lotItemId },
        _sum: { quantityOnHand: true, damagedQuantity: true },
      });
      const lotRemaining = (lotStock._sum.quantityOnHand ?? 0) + (lotStock._sum.damagedQuantity ?? 0);
      const quarantineLeft = (lotItem.quarantineQty ?? order.scrapQty) - order.scrapQty;

      if (lotRemaining === 0) {
        await tx.productLotItem.update({ where: { id: lotItem.id }, data: { status: "SCRAPPED" } });
      } else if (quarantineLeft > 0) {
        await tx.productLotItem.update({ where: { id: lotItem.id }, data: { quarantineQty: quarantineLeft } });
      } else {
        await tx.productLotItem.update({
          where: { id: lotItem.id },
          data: {
            status: lotStatusService.calculateStatus(lotItem.expirationDate),
            quarantineQty: null,
            quarantinedAt: null,
            quarantinedBy: null,
            quarantineNote: null,
          },
        });
      }

      const completed = await tx.scrapOrder.update({
        where: { id: scrapOrderId },
        data: {
          status: "COMPLETED",
          approvedBy: actor.userId,
          approvedAt: new Date(),
          // In this database total_loss_value is a plain column (not generated), so the loss is stored here.
          totalLossValue: totalCost,
        },
        include: orderInclude,
      });

      return {
        scrapOrder: formatScrapOrder(completed),
        inventoryReduced: order.scrapQty,
        lossAmount: Number(totalCost),
        lotScrapped: lotRemaining === 0,
        ledgerCreated: true,
      };
    });

    return result;
  }

  /**
   * Owner only, with or without photos (a missing photo is itself a valid reason).
   * Final: the lot stays QUARANTINED and staff create a new scrap order.
   */
  async rejectScrapOrder(
    businessId: string,
    actor: ScrapActor,
    scrapOrderId: string,
    body: { reasonCode?: unknown; note?: unknown },
  ) {
    assertOwner(actor);
    assertUuid(scrapOrderId, "Scrap order");

    const reasonCode = String(body.reasonCode ?? "");
    if (!(REJECTION_REASON_CODES as readonly string[]).includes(reasonCode)) {
      throw new HttpError(400, `reasonCode must be one of ${REJECTION_REASON_CODES.join(", ")}.`);
    }
    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
      throw new HttpError(400, "note must be text.");
    }
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
    if (note && note.length > 500) {
      throw new HttpError(400, "note must be 500 characters or fewer.");
    }

    return prisma.$transaction(async (tx) => {
      const locked = await lockScrapOrder(tx, businessId, scrapOrderId);
      if (locked.status !== "PENDING") {
        throw new HttpError(409, `Phiếu hủy đang ${scrapStatusLabel(locked.status)} không thể bị từ chối.`);
      }
      const rejected = await tx.scrapOrder.update({
        where: { id: scrapOrderId },
        data: {
          status: "REJECTED",
          rejectedBy: actor.userId,
          rejectedAt: new Date(),
          rejectionReasonCode: reasonCode,
          rejectionNote: note,
        },
        include: orderInclude,
      });
      return formatScrapOrder(rejected);
    });
  }

  /**
   * Owner only. Closes a PENDING order without approving or rejecting it: no stock, ledger or lot
   * change, so the lot item stays QUARANTINED and the photos stay as they were. Used when the
   * order can no longer be judged, for example when the staff member who raised it has left.
   */
  async cancelScrapOrder(
    businessId: string,
    actor: ScrapActor,
    scrapOrderId: string,
    body: { note?: unknown },
  ) {
    assertOwner(actor);
    assertUuid(scrapOrderId, "Scrap order");

    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
      throw new HttpError(400, "note must be text.");
    }
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
    if (note && note.length > 500) {
      throw new HttpError(400, "note must be 500 characters or fewer.");
    }

    return prisma.$transaction(async (tx) => {
      const locked = await lockScrapOrder(tx, businessId, scrapOrderId);
      if (locked.status !== "PENDING") {
        throw new HttpError(409, `Phiếu hủy đang ${scrapStatusLabel(locked.status)} không thể bị huỷ.`);
      }
      const cancelled = await tx.scrapOrder.update({
        where: { id: scrapOrderId },
        data: {
          status: "CANCELLED",
          cancelledBy: actor.userId,
          cancelledAt: new Date(),
          cancelledNote: note,
        },
        include: orderInclude,
      });
      return formatScrapOrder(cancelled);
    });
  }

  async getScrapStatistics(businessId: string) {
    const [byStatus, bySource, loss] = await Promise.all([
      prisma.scrapOrder.groupBy({ by: ["status"], where: { businessId }, _count: { _all: true } }),
      prisma.scrapOrder.groupBy({ by: ["scrapSource"], where: { businessId }, _count: { _all: true } }),
      prisma.scrapOrder.aggregate({
        where: { businessId, status: "COMPLETED" },
        _sum: { totalLossValue: true },
      }),
    ]);

    const statusCount = (status: string) => byStatus.find((row) => row.status === status)?._count._all ?? 0;
    const sourceCount = (source: string) => bySource.find((row) => row.scrapSource === source)?._count._all ?? 0;

    return {
      pendingCount: statusCount("PENDING"),
      completedCount: statusCount("COMPLETED"),
      rejectedCount: statusCount("REJECTED"),
      cancelledCount: statusCount("CANCELLED"),
      // Only approved scrap counts as a loss.
      totalLossValue: Number(loss._sum.totalLossValue ?? 0),
      bySource: {
        DAMAGED_STOCK: sourceCount("DAMAGED_STOCK"),
        SELLABLE_STOCK: sourceCount("SELLABLE_STOCK"),
      },
    };
  }
}
