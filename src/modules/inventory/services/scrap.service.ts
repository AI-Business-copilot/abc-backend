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
  lockScrapOrder,
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
  lot: { select: { id: true, lotNumber: true, expirationDate: true, status: true, quarantineQty: true } },
  createdByUser: userSelect,
  approvedByUser: userSelect,
  rejectedByUser: userSelect,
} satisfies Prisma.ScrapOrderInclude;

const lotStatusService = new LotStatusService();
const imageService = new ScrapImageService();

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
    lotId: string,
    source: ScrapSource,
  ) {
    const balance = await db.inventoryBalance.findFirst({ where: { businessId, variantId, lotId } });
    if (!balance) {
      throw new HttpError(409, "No inventory balance found for this lot.");
    }
    const available = source === "DAMAGED_STOCK" ? balance.damagedQuantity : balance.quantityOnHand;
    return { balance, available };
  }

  /**
   * STAFF only. The lot must be QUARANTINED and have no other PENDING scrap order.
   * Needs 1 to 10 evidence photos, which are saved with the order and cannot be changed afterward.
   */
  async createScrapOrder(
    businessId: string,
    actor: ScrapActor,
    data: {
      lotId?: unknown;
      variantId?: unknown;
      scrapQty?: unknown;
      scrapSource?: unknown;
      scrapReason?: unknown;
    },
    files: { buffer: Buffer }[] | undefined,
  ) {
    assertStaff(actor);
    const lotId = assertUuid(data.lotId, "Lot");
    const scrapReason = parseReason(data.scrapReason);
    const images = imageService.prepareImages(files);

    const lot = await prisma.productLot.findFirst({
      where: { id: lotId, businessId },
      include: { variant: true },
    });
    if (!lot) {
      throw new HttpError(404, "Lot not found");
    }
    if (data.variantId !== undefined && data.variantId !== lot.variantId) {
      throw new HttpError(400, "variantId does not match this lot.");
    }
    if (lot.status !== "QUARANTINED") {
      throw new HttpError(409, "Only a quarantined lot can be scrapped. Quarantine the lot first.");
    }

    const scrapQty =
      data.scrapQty === undefined || data.scrapQty === null
        ? lot.quarantineQty
        : parseQuantity(data.scrapQty, "scrapQty");
    if (!scrapQty || scrapQty <= 0) {
      throw new HttpError(400, "scrapQty is required because this lot has no recorded quarantine quantity.");
    }
    if (lot.quarantineQty && scrapQty > lot.quarantineQty) {
      throw new HttpError(409, `scrapQty ${scrapQty} is more than the ${lot.quarantineQty} unit(s) quarantined.`);
    }

    let scrapSource: ScrapSource;
    if (data.scrapSource === undefined || data.scrapSource === null) {
      const balance = await prisma.inventoryBalance.findFirst({
        where: { businessId, variantId: lot.variantId, lotId },
      });
      scrapSource = balance && balance.quantityOnHand >= scrapQty ? "SELLABLE_STOCK" : "DAMAGED_STOCK";
    } else if (data.scrapSource === "DAMAGED_STOCK" || data.scrapSource === "SELLABLE_STOCK") {
      scrapSource = data.scrapSource;
    } else {
      throw new HttpError(400, "scrapSource must be DAMAGED_STOCK or SELLABLE_STOCK.");
    }

    const { available } = await this.availableFor(prisma, businessId, lot.variantId, lotId, scrapSource);
    if (available < scrapQty) {
      throw new HttpError(
        409,
        `Insufficient ${scrapSource === "DAMAGED_STOCK" ? "damaged" : "sellable"} quantity. Available: ${available}, requested: ${scrapQty}.`,
      );
    }

    // Cheap check before touching Storage. The loop below checks again in case of a race.
    if ((await prisma.scrapOrder.count({ where: { businessId, lotId, status: "PENDING" } })) > 0) {
      throw new HttpError(409, "This lot already has a scrap order waiting for review.");
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
        const pending = await prisma.scrapOrder.count({ where: { businessId, lotId, status: "PENDING" } });
        if (pending > 0) {
          throw new HttpError(409, "This lot already has a scrap order waiting for review.");
        }

        try {
          // One nested create: the order and its photos are saved together or not at all.
          return await prisma.scrapOrder.create({
            data: {
              id: orderId,
              businessId,
              scrapCode: await this.generateScrapCode(businessId),
              variantId: lot.variantId,
              lotId,
              scrapQty,
              unitCost: lot.variant.costPrice,
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
        } catch (error) {
          // P2002 is either a duplicate scrap code (retry with a fresh one) or the one-PENDING-per-lot index.
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

    return { orders, total };
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
    return { ...order, images };
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
        throw new HttpError(409, `A ${locked.status} scrap order cannot be changed.`);
      }

      if (newQty !== undefined) {
        const order = await tx.scrapOrder.findFirstOrThrow({
          where: { id: scrapOrderId, businessId },
          include: { lot: { select: { quarantineQty: true } } },
        });
        if (order.lot?.quarantineQty && newQty > order.lot.quarantineQty) {
          throw new HttpError(409, `scrapQty ${newQty} is more than the ${order.lot.quarantineQty} unit(s) quarantined.`);
        }
        if (!order.lotId) {
          throw new HttpError(409, "This scrap order has no lot.");
        }
        const { available } = await this.availableFor(
          tx,
          businessId,
          order.variantId,
          order.lotId,
          order.scrapSource as ScrapSource,
        );
        if (available < newQty) {
          throw new HttpError(409, `Insufficient quantity available. Available: ${available}, requested: ${newQty}.`);
        }
      }

      return tx.scrapOrder.update({ where: { id: scrapOrderId }, data: update, include: orderInclude });
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
        throw new HttpError(409, `A ${locked.status} scrap order cannot be deleted.`);
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
        throw new HttpError(409, `A ${locked.status} scrap order cannot be approved.`);
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
      if (!order.lotId) {
        throw new HttpError(409, "This scrap order has no lot.");
      }
      const lot = await tx.productLot.findFirstOrThrow({ where: { id: order.lotId, businessId } });
      if (lot.status !== "QUARANTINED") {
        throw new HttpError(409, `The lot is ${lot.status}, not QUARANTINED, so it cannot be scrapped.`);
      }

      const source = order.scrapSource as ScrapSource;
      const { balance } = await this.availableFor(tx, businessId, order.variantId, order.lotId, source);

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
          lotId: order.lotId,
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

      // The lot is SCRAPPED only when nothing is left on it; otherwise it keeps what is still quarantined.
      const lotStock = await tx.inventoryBalance.aggregate({
        where: { businessId, lotId: order.lotId },
        _sum: { quantityOnHand: true, damagedQuantity: true },
      });
      const lotRemaining = (lotStock._sum.quantityOnHand ?? 0) + (lotStock._sum.damagedQuantity ?? 0);
      const quarantineLeft = (lot.quarantineQty ?? order.scrapQty) - order.scrapQty;

      if (lotRemaining === 0) {
        await tx.productLot.update({ where: { id: lot.id }, data: { status: "SCRAPPED" } });
      } else if (quarantineLeft > 0) {
        await tx.productLot.update({ where: { id: lot.id }, data: { quarantineQty: quarantineLeft } });
      } else {
        await tx.productLot.update({
          where: { id: lot.id },
          data: {
            status: lotStatusService.calculateStatus(lot.expirationDate),
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
        scrapOrder: completed,
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
        throw new HttpError(409, `A ${locked.status} scrap order cannot be rejected.`);
      }
      return tx.scrapOrder.update({
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
      // Only approved scrap counts as a loss.
      totalLossValue: Number(loss._sum.totalLossValue ?? 0),
      bySource: {
        DAMAGED_STOCK: sourceCount("DAMAGED_STOCK"),
        SELLABLE_STOCK: sourceCount("SELLABLE_STOCK"),
      },
    };
  }
}
