import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { HttpError } from "../../../shared/http/http-error";
import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { deleteObjects, uploadObject } from "../../../shared/infrastructure/storage/supabase-storage";
import {
  DISPOSAL_METHODS,
  MIN_DISPOSAL_WITNESSES,
  SCRAP_CAUSE_CODES,
  scrapCauseCodeLabel,
  type DisposalMethod,
  type ScrapCauseCode,
} from "../scrap.types";
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
  business: { select: { industryType: true } },
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

/**
 * The plain-text reason of the loss, written from the cause code. The cause code is the only
 * thing staff state, so the reason is never asked for: the label of the code is what the
 * order carries, and it keeps the historical `scrap_reason` column filled for the old readers.
 */
function reasonFromCauseCode(causeCode: ScrapCauseCode): string {
  return scrapCauseCodeLabel[causeCode];
}

/** The cause of the loss, one of the four codes the dossier accepts. */
function parseCauseCode(value: unknown): ScrapCauseCode {
  const code = String(value ?? "");
  if (!(SCRAP_CAUSE_CODES as readonly string[]).includes(code)) {
    throw new HttpError(400, `causeCode must be one of ${SCRAP_CAUSE_CODES.join(", ")}.`);
  }
  return code as ScrapCauseCode;
}

/** How the goods are destroyed. */
function parseDisposalMethod(value: unknown): DisposalMethod {
  const method = String(value ?? "");
  if (!(DISPOSAL_METHODS as readonly string[]).includes(method)) {
    throw new HttpError(400, `disposalMethod must be one of ${DISPOSAL_METHODS.join(", ")}.`);
  }
  return method as DisposalMethod;
}

/** Where the goods are destroyed. A contractor needs an address, so the location is required there. */
function parseDisposalLocation(value: unknown): string {
  const location = String(value ?? "").trim();
  if (!location) {
    throw new HttpError(400, "disposalLocation is required.");
  }
  if (location.length > 255) {
    throw new HttpError(400, "disposalLocation must be 255 characters or fewer.");
  }
  return location;
}

/** The council members, separated by commas. The tax dossier needs at least two of them. */
function parseWitnessNames(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "witnessNames must list the council members, separated by commas.");
  }
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length < MIN_DISPOSAL_WITNESSES) {
    throw new HttpError(400, `witnessNames must list at least ${MIN_DISPOSAL_WITNESSES} council members.`);
  }
  if (names.join(", ").length > 500) {
    throw new HttpError(400, "witnessNames must be 500 characters or fewer.");
  }
  return names;
}

/** The amount recovered from an insurer or a third party. It cannot be negative. */
function parseCompensatedAmount(value: unknown): Prisma.Decimal {
  const amount = new Prisma.Decimal(String(value ?? 0));
  if (amount.isNegative() || !amount.isFinite()) {
    throw new HttpError(400, "compensatedAmount must be zero or more.");
  }
  return amount;
}

/** A day that has already passed. The dossier cannot claim a disposal that did not happen yet. */
function parseDisposalDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "disposalDate must be a valid date.");
  }
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  if (date.getTime() > endOfToday.getTime()) {
    throw new HttpError(400, "disposalDate cannot be in the future.");
  }
  return date;
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
    lotItemId: string | null,
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
   * STAFF only. The target is either a lot item or, for a product with no lot, a variant.
   * A lot item must be QUARANTINED; a variant must have a variant quarantine. Either way there
   * must be no other PENDING scrap order for that target. A rejected or cancelled order does not
   * block a new one: the stock stays quarantined and any staff member can file a fresh order.
   * Needs 1 to 10 evidence photos, which are saved with the order and cannot be changed afterward.
   * The cause, the disposal method and the disposal location are required: the tax dossier asks
   * for them, and the order cannot be approved without them.
   */
  async createScrapOrder(
    businessId: string,
    actor: ScrapActor,
    data: {
      lotItemId?: unknown;
      variantId?: unknown;
      scrapQty?: unknown;
      scrapSource?: unknown;
      causeCode?: unknown;
      disposalMethod?: unknown;
      disposalLocation?: unknown;
    },
    files: { buffer: Buffer }[] | undefined,
  ) {
    assertStaff(actor);
    if (data.causeCode === undefined || data.causeCode === null || data.causeCode === "") {
      throw new HttpError(400, "Vui lòng chọn nguyên nhân hủy hàng.");
    }
    if (data.disposalMethod === undefined || data.disposalMethod === null || data.disposalMethod === "") {
      throw new HttpError(400, "Vui lòng chọn phương thức tiêu hủy.");
    }
    if (data.disposalLocation === undefined || data.disposalLocation === null || String(data.disposalLocation).trim() === "") {
      throw new HttpError(400, "Vui lòng nhập địa điểm tiêu hủy.");
    }
    const causeCode = parseCauseCode(data.causeCode);
    const scrapReason = reasonFromCauseCode(causeCode);
    const disposalMethod = parseDisposalMethod(data.disposalMethod);
    const disposalLocation = parseDisposalLocation(data.disposalLocation);
    const images = imageService.prepareImages(files);

    // The target is a lot item when one is given, otherwise the variant itself.
    const rawLotItemId = typeof data.lotItemId === "string" ? data.lotItemId.trim() : "";
    const lotItemId = rawLotItemId ? assertUuid(data.lotItemId, "Lot item") : null;

    let variantId: string;
    let unitCost: Prisma.Decimal;
    let quarantineQty: number | null;
    let lotStatus: string | null = null;

    if (lotItemId) {
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
      variantId = lotItem.variantId;
      unitCost = lotItem.variant.costPrice;
      quarantineQty = lotItem.quarantineQty;
      lotStatus = lotItem.status;
    } else {
      // No lot item: the order targets the variant. The variant must be quarantined first,
      // exactly as a lot item must be QUARANTINED.
      variantId = assertUuid(data.variantId, "Variant");
      const variant = await prisma.productVariant.findFirst({
        where: { id: variantId, businessId },
        select: { costPrice: true, isLockedForAudit: true },
      });
      if (!variant) {
        throw new HttpError(404, "Variant not found");
      }
      if (variant.isLockedForAudit) {
        throw new HttpError(409, "This SKU is locked for a stock audit. Finish the count before scrapping its stock.");
      }
      const quarantine = await prisma.variantQuarantine.findFirst({
        where: { businessId, variantId },
        select: { quarantineQty: true },
      });
      if (!quarantine) {
        throw new HttpError(409, "Only a quarantined SKU can be scrapped. Quarantine it first.");
      }
      unitCost = variant.costPrice;
      quarantineQty = quarantine.quarantineQty;
    }

    const scrapQty =
      data.scrapQty === undefined || data.scrapQty === null
        ? quarantineQty
        : parseQuantity(data.scrapQty, "scrapQty");
    if (!scrapQty || scrapQty <= 0) {
      throw new HttpError(400, "scrapQty is required because this target has no recorded quarantine quantity.");
    }
    if (quarantineQty && scrapQty > quarantineQty) {
      throw new HttpError(409, `scrapQty ${scrapQty} is more than the ${quarantineQty} unit(s) quarantined.`);
    }

    let scrapSource: ScrapSource;
    if (data.scrapSource === undefined || data.scrapSource === null) {
      const balance = await prisma.inventoryBalance.findFirst({
        where: { businessId, variantId, lotItemId },
      });
      scrapSource = balance && balance.quantityOnHand >= scrapQty ? "SELLABLE_STOCK" : "DAMAGED_STOCK";
    } else if (data.scrapSource === "DAMAGED_STOCK" || data.scrapSource === "SELLABLE_STOCK") {
      scrapSource = data.scrapSource;
    } else {
      throw new HttpError(400, "scrapSource must be DAMAGED_STOCK or SELLABLE_STOCK.");
    }

    const { available } = await this.availableFor(prisma, businessId, variantId, lotItemId, scrapSource);
    if (available < scrapQty) {
      throw new HttpError(
        409,
        `Insufficient ${scrapSource === "DAMAGED_STOCK" ? "damaged" : "sellable"} quantity. Available: ${available}, requested: ${scrapQty}.`,
      );
    }

    // Cheap check before touching Storage. The loop below checks again in case of a race.
    // Only a PENDING order blocks: a rejected or cancelled order is settled, so the stock stays
    // quarantined and any staff member can file a fresh order.
    const existingOrder = await prisma.scrapOrder.findFirst({
      where: { businessId, ...(lotItemId ? { lotItemId } : { variantId, lotItemId: null }), status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { scrapCode: true, status: true },
    });
    if (existingOrder) {
      throw new HttpError(
        409,
        `${lotItemId ? "This lot item" : "This SKU"} already has a scrap order waiting for review (${existingOrder.scrapCode}). ` +
          `Wait for the Owner to settle it before creating another.`,
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
          where: { businessId, ...(lotItemId ? { lotItemId } : { variantId, lotItemId: null }), status: "PENDING" },
          orderBy: { createdAt: "desc" },
          select: { scrapCode: true, status: true },
        });
        if (existing) {
          throw new HttpError(
            409,
            `${lotItemId ? "This lot item" : "This SKU"} already has a scrap order waiting for review (${existing.scrapCode}). ` +
              `Wait for the Owner to settle it before creating another.`,
          );
        }

        try {
          // One nested create: the order and its photos are saved together or not at all.
          const created = await prisma.scrapOrder.create({
            data: {
              id: orderId,
              businessId,
              scrapCode: await this.generateScrapCode(businessId),
              variantId,
              lotItemId,
              scrapQty,
              unitCost,
              scrapSource,
              scrapReason,
              causeCode,
              disposalMethod,
              disposalLocation,
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
          // P2002 is either a duplicate scrap code (retry with a fresh one) or the one-PENDING-per-target index.
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
    data: { scrapQty?: unknown; causeCode?: unknown },
  ) {
    assertStaff(actor);
    assertUuid(scrapOrderId, "Scrap order");

    const update: Prisma.ScrapOrderUpdateInput = {};
    if (data.causeCode !== undefined) {
      const causeCode = parseCauseCode(data.causeCode);
      update.causeCode = causeCode;
      // The reason follows the cause, so the two can never disagree.
      update.scrapReason = reasonFromCauseCode(causeCode);
    }
    const newQty = data.scrapQty !== undefined ? parseQuantity(data.scrapQty, "scrapQty") : undefined;
    if (newQty !== undefined) update.scrapQty = newQty;
    if (Object.keys(update).length === 0) {
      throw new HttpError(400, "Send scrapQty or causeCode to update.");
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
        // The cap is the quarantined quantity: the lot item's for a lot order, the variant's for a
        // product that has no lot.
        if (order.lotItemId) {
          if (order.lotItem?.quarantineQty && newQty > order.lotItem.quarantineQty) {
            throw new HttpError(409, `scrapQty ${newQty} is more than the ${order.lotItem.quarantineQty} unit(s) quarantined.`);
          }
        } else {
          const quarantine = await tx.variantQuarantine.findFirst({
            where: { businessId, variantId: order.variantId },
            select: { quarantineQty: true },
          });
          if (!quarantine) {
            throw new HttpError(409, "This scrap order has no lot item and its SKU is not quarantined.");
          }
          if (newQty > quarantine.quarantineQty) {
            throw new HttpError(409, `scrapQty ${newQty} is more than the ${quarantine.quarantineQty} unit(s) quarantined.`);
          }
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
      await assertVariantNotLockedForAudit(tx, businessId, order.variantId);

      // The target is either a lot item or, for a product with no lot, the variant itself.
      let lotItem: { id: string; status: string; expirationDate: Date; quarantineQty: number | null } | null = null;
      let variantQuarantine: { id: string; quarantineQty: number } | null = null;

      if (order.lotItemId) {
        lotItem = await tx.productLotItem.findFirstOrThrow({ where: { id: order.lotItemId, businessId } });
        if (lotItem.status !== "QUARANTINED") {
          throw new HttpError(
            409,
            `Lô hàng đang ${lotStatusLabel(lotItem.status)}, không phải đang cách ly, nên không thể hủy hàng.`,
          );
        }
      } else {
        variantQuarantine = await tx.variantQuarantine.findFirst({
          where: { businessId, variantId: order.variantId },
          select: { id: true, quarantineQty: true },
        });
        if (!variantQuarantine) {
          throw new HttpError(409, "This scrap order has no lot item and its SKU is not quarantined.");
        }
      }

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
      // A variant-level order consumes its quarantine instead: the quantity drops, and the record goes
      // away when nothing is left to quarantine.
      let lotScrapped = false;

      if (lotItem) {
        const lotStock = await tx.inventoryBalance.aggregate({
          where: { businessId, lotItemId: order.lotItemId },
          _sum: { quantityOnHand: true, damagedQuantity: true },
        });
        const lotRemaining = (lotStock._sum.quantityOnHand ?? 0) + (lotStock._sum.damagedQuantity ?? 0);
        const quarantineLeft = (lotItem.quarantineQty ?? order.scrapQty) - order.scrapQty;

        if (lotRemaining === 0) {
          await tx.productLotItem.update({ where: { id: lotItem.id }, data: { status: "SCRAPPED" } });
          lotScrapped = true;
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
      } else if (variantQuarantine) {
        const quarantineLeft = variantQuarantine.quarantineQty - order.scrapQty;
        if (quarantineLeft > 0) {
          await tx.variantQuarantine.update({
            where: { id: variantQuarantine.id },
            data: { quarantineQty: quarantineLeft, updatedAt: new Date() },
          });
        } else {
          await tx.variantQuarantine.delete({ where: { id: variantQuarantine.id } });
        }
      }

      // The disposal council is the approver (who leads it) and the staff member who wrote the
      // minutes. Both names are needed, because the dossier asks for at least two council members.
      const councilUsers = await tx.user.findMany({
        where: { id: { in: [actor.userId, order.createdBy] } },
        select: { id: true, fullName: true },
      });
      const approverName = councilUsers.find((member) => member.id === actor.userId)?.fullName.trim() ?? "";
      const creatorName = councilUsers.find((member) => member.id === order.createdBy)?.fullName.trim() ?? "";
      // The approver leads the council, so their name comes first.
      const councilNames = [approverName, creatorName].filter(Boolean);
      if (councilNames.length < MIN_DISPOSAL_WITNESSES) {
        throw new HttpError(409, "Không tìm đủ thành viên hội đồng tiêu hủy để lập biên bản.");
      }

      const completed = await tx.scrapOrder.update({
        where: { id: scrapOrderId },
        data: {
          status: "COMPLETED",
          approvedBy: actor.userId,
          approvedAt: new Date(),
          // In this database total_loss_value is a plain column (not generated), so the loss is stored here.
          totalLossValue: totalCost,
          witnessNames: councilNames.join(", "),
        },
        include: orderInclude,
      });

      return {
        scrapOrder: formatScrapOrder(completed),
        inventoryReduced: order.scrapQty,
        lossAmount: Number(totalCost),
        lotScrapped,
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

  /**
   * Staff or owner, while the order is still PENDING. Records the parts of the disposal dossier
   * that the tax rules ask for: the cause of the loss, the amount recovered from an insurer or a
   * third party, and how and where the goods will be destroyed together with the council members.
   * Every field is optional, so a dossier can be filled in over several steps.
   */
  async recordDisposalDossier(
    businessId: string,
    actor: ScrapActor,
    scrapOrderId: string,
    data: {
      causeCode?: unknown;
      compensatedAmount?: unknown;
      disposalDate?: unknown;
      disposalMethod?: unknown;
      disposalLocation?: unknown;
      witnessNames?: unknown;
    },
  ) {
    if (!actor.userId || !actor.role) {
      throw new HttpError(403, "Only a member of this business can do this.");
    }
    assertUuid(scrapOrderId, "Scrap order");

    const update: Prisma.ScrapOrderUpdateInput = {};
    let compensated: Prisma.Decimal | null = null;

    if (data.causeCode !== undefined && data.causeCode !== null && data.causeCode !== "") {
      const causeCode = parseCauseCode(data.causeCode);
      update.causeCode = causeCode;
      // The reason follows the cause, so the two can never disagree.
      update.scrapReason = reasonFromCauseCode(causeCode);
    }
    if (data.disposalMethod !== undefined && data.disposalMethod !== null && data.disposalMethod !== "") {
      update.disposalMethod = parseDisposalMethod(data.disposalMethod);
    }
    if (data.disposalLocation !== undefined && data.disposalLocation !== null) {
      const location = String(data.disposalLocation).trim();
      if (location.length > 255) {
        throw new HttpError(400, "disposalLocation must be 255 characters or fewer.");
      }
      update.disposalLocation = location || null;
    }
    if (data.witnessNames !== undefined && data.witnessNames !== null && data.witnessNames !== "") {
      update.witnessNames = parseWitnessNames(data.witnessNames).join(", ");
    }
    if (data.compensatedAmount !== undefined && data.compensatedAmount !== null) {
      compensated = parseCompensatedAmount(data.compensatedAmount);
      update.compensatedAmount = compensated;
    }
    if (data.disposalDate !== undefined && data.disposalDate !== null && data.disposalDate !== "") {
      update.disposalDate = parseDisposalDate(data.disposalDate);
    }

    if (Object.keys(update).length === 0) {
      throw new HttpError(400, "Send at least one dossier field to record.");
    }

    return prisma.$transaction(async (tx) => {
      const locked = await lockScrapOrder(tx, businessId, scrapOrderId);
      if (locked.status !== "PENDING") {
        throw new HttpError(409, `Phiếu hủy đang ${scrapStatusLabel(locked.status)} không thể được bổ sung hồ sơ.`);
      }

      // A contractor needs an address, so the location is checked against the method that is
      // stored now or that this request brings.
      const method = update.disposalMethod ?? (await this.currentDisposalMethod(tx, businessId, scrapOrderId));
      const location = update.disposalLocation ?? (await this.currentDisposalLocation(tx, businessId, scrapOrderId));
      if (method === "CONTRACTOR" && !location) {
        throw new HttpError(400, "disposalLocation is required when the goods are destroyed by a contractor.");
      }

      // The recovered amount can never be larger than the loss it comes from.
      const order = await tx.scrapOrder.findFirstOrThrow({
        where: { id: scrapOrderId, businessId },
        select: { scrapQty: true, unitCost: true },
      });
      const loss = new Prisma.Decimal(order.unitCost).mul(order.scrapQty);
      const current = compensated ?? (await this.currentCompensatedAmount(tx, businessId, scrapOrderId));
      if (current.gt(loss)) {
        throw new HttpError(400, "compensatedAmount cannot be more than the loss it comes from.");
      }

      const updated = await tx.scrapOrder.update({ where: { id: scrapOrderId }, data: update, include: orderInclude });
      return formatScrapOrder(updated);
    });
  }

  /**
   * Owner only, on an approved order. Records the day the goods were physically destroyed, which
   * completes the disposal minutes (bước 5). The quantity was already written off when the order
   * was approved, so this only writes an audit row in the ledger.
   */
  async confirmPhysicalDisposal(
    businessId: string,
    actor: ScrapActor,
    scrapOrderId: string,
    body: { disposalDate?: unknown },
  ) {
    assertOwner(actor);
    assertUuid(scrapOrderId, "Scrap order");

    const disposalDate = body.disposalDate === undefined || body.disposalDate === null || body.disposalDate === ""
      ? new Date()
      : parseDisposalDate(body.disposalDate);

    return prisma.$transaction(async (tx) => {
      const locked = await lockScrapOrder(tx, businessId, scrapOrderId);
      if (locked.status !== "COMPLETED") {
        throw new HttpError(
          409,
          `Phiếu hủy đang ${scrapStatusLabel(locked.status)} chưa được duyệt nên chưa thể xác nhận tiêu hủy.`,
        );
      }

      const order = await tx.scrapOrder.findFirstOrThrow({ where: { id: scrapOrderId, businessId } });
      if (order.disposalDate) {
        throw new HttpError(409, "This scrap order was already confirmed as disposed of.");
      }

      // The write-off row the approval created, so the audit trail points back at it.
      const disposalEntry = await tx.inventoryLedger.findFirst({
        where: { businessId, referenceDocType: "SCRAP_ORDER", referenceDocId: scrapOrderId },
        orderBy: { createdAt: "asc" },
        select: { id: true, balanceAfter: true },
      });

      const variantTotal = await tx.inventoryBalance.aggregate({
        where: { businessId, variantId: order.variantId },
        _sum: { quantityOnHand: true },
      });

      await tx.inventoryLedger.create({
        data: {
          businessId,
          variantId: order.variantId,
          lotItemId: order.lotItemId,
          transactionType: "SCRAP_PHYSICALLY_DISPOSED",
          // The stock was already written off, so this row moves no quantity.
          quantityChanged: 0,
          balanceAfter: variantTotal._sum.quantityOnHand ?? 0,
          unitCost: order.unitCost,
          totalCostValue: new Prisma.Decimal(0),
          referenceDocType: "SCRAP_ORDER",
          referenceDocId: scrapOrderId,
          createdBy: actor.userId,
        },
      });

      const updated = await tx.scrapOrder.update({
        where: { id: scrapOrderId },
        data: { disposalDate },
        include: orderInclude,
      });

      return {
        scrapOrder: formatScrapOrder(updated),
        disposalDate,
        disposalLedgerId: disposalEntry?.id ?? null,
      };
    });
  }

  /**
   * The dossier as the tax rules ask for it: the six steps of the disposal procedure, the bảng kê
   * xuất nhập tồn built from the ledger, and the amounts that decide what may be deducted.
   */
  async generateDossierReport(businessId: string, scrapOrderId: string) {
    assertUuid(scrapOrderId, "Scrap order");

    const order = await prisma.scrapOrder.findFirst({
      where: { id: scrapOrderId, businessId },
      include: {
        ...orderInclude,
        business: { select: { name: true, address: true, industryType: true } },
      },
    });
    if (!order) {
      throw new HttpError(404, "Scrap order not found");
    }
    if (order.status !== "COMPLETED") {
      throw new HttpError(
        409,
        `Hồ sơ tiêu hủy chỉ được lập cho phiếu đã duyệt. Phiếu này đang ${scrapStatusLabel(order.status)}.`,
      );
    }

    // The bảng kê xuất nhập tồn: every movement of this lot item (or of this SKU when the product
    // has no lot) up to the day of the disposal.
    const ledger = await prisma.inventoryLedger.findMany({
      where: {
        businessId,
        variantId: order.variantId,
        ...(order.lotItemId ? { lotItemId: order.lotItemId } : { lotItemId: null }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        createdAt: true,
        transactionType: true,
        quantityChanged: true,
        unitCost: true,
        totalCostValue: true,
        referenceDocType: true,
        referenceDocId: true,
      },
    });

    const witnesses = (order.witnessNames ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    const totalLossValue = Number(order.totalLossValue ?? 0);
    const compensatedAmount = Number(order.compensatedAmount ?? 0);

    return {
      scrapCode: order.scrapCode,
      businessName: order.business?.name ?? "",
      businessAddress: order.business?.address ?? null,
      step1_council: {
        leader: order.approvedByUser?.fullName ?? order.createdByUser?.fullName ?? "",
        accountant: witnesses[1] ?? null,
        createdDate: order.createdAt ? order.createdAt.toISOString() : null,
      },
      step2_inspection: {
        productName: order.variant.template?.name ?? "",
        sku: order.variant.sku,
        lotNumber: order.lotItem?.lot.lotNumber ?? null,
        expiryDate: order.lotItem?.expirationDate ? order.lotItem.expirationDate.toISOString() : null,
        quantity: order.scrapQty,
        unitCost: Number(order.unitCost),
        totalValue: totalLossValue,
        // The condition of the goods, not the cause of the loss: the cause is stated once, in step 3.
        condition: order.lotItem?.status ?? "UNRECORDED",
        createdDate: order.createdAt ? order.createdAt.toISOString() : null,
      },
      step3_decision: {
        causeCode: order.causeCode as ScrapCauseCode | null,
        disposalMethod: order.disposalMethod as DisposalMethod | null,
        disposalLocation: order.disposalLocation,
        approvedBy: order.approvedByUser?.fullName ?? null,
        approvedDate: order.approvedAt ? order.approvedAt.toISOString() : null,
        witnesses,
      },
      step4_execution: {
        status: order.disposalMethod
          ? `Đã ghi nhận phương thức tiêu hủy: ${order.disposalMethod}`
          : "Chưa ghi nhận",
      },
      step5_disposal: {
        actualDate: order.disposalDate ? order.disposalDate.toISOString() : null,
        confirmedBy: order.approvedByUser?.fullName ?? null,
      },
      step6_archive_bangke: {
        bangKeXuatNhapTon: ledger.map((entry) => ({
          date: entry.createdAt ? entry.createdAt.toISOString() : "",
          transactionType: entry.transactionType,
          quantity: entry.quantityChanged,
          unitCost: Number(entry.unitCost),
          totalValue: Number(entry.totalCostValue),
          note: `${entry.referenceDocType}:${entry.referenceDocId}`,
        })),
      },
      tax_fields: {
        totalLossValue,
        compensatedAmount,
        // Only the part of the loss that was not compensated may be deducted.
        deductibleLoss: totalLossValue - compensatedAmount,
        taxLegislation: "Thông tư 96/2015 sửa đổi Thông tư 78/2014/TT-BTC",
      },
    };
  }

  private async currentDisposalMethod(
    db: Prisma.TransactionClient,
    businessId: string,
    scrapOrderId: string,
  ): Promise<string | null> {
    const order = await db.scrapOrder.findFirst({ where: { id: scrapOrderId, businessId }, select: { disposalMethod: true } });
    return order?.disposalMethod ?? null;
  }

  private async currentDisposalLocation(
    db: Prisma.TransactionClient,
    businessId: string,
    scrapOrderId: string,
  ): Promise<string | null> {
    const order = await db.scrapOrder.findFirst({ where: { id: scrapOrderId, businessId }, select: { disposalLocation: true } });
    return order?.disposalLocation ?? null;
  }

  private async currentCompensatedAmount(
    db: Prisma.TransactionClient,
    businessId: string,
    scrapOrderId: string,
  ): Promise<Prisma.Decimal> {
    const order = await db.scrapOrder.findFirst({ where: { id: scrapOrderId, businessId }, select: { compensatedAmount: true } });
    return order?.compensatedAmount ?? new Prisma.Decimal(0);
  }
}
