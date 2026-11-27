import { Prisma, StockTransactionType } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../../shared/http/http-error";
import { deleteObjects, uploadObject } from "../../../shared/infrastructure/storage/supabase-storage";
import { AuditImageService, type PreparedAuditImage } from "./audit-image.service";
import { LotStatusService } from "./lot-status.service";
import { scrapStatusLabel } from "./scrap-access";

const num = (value: unknown) => Number(value ?? 0);

const imageService = new AuditImageService();

/**
 * How the two counters of a row compare:
 *   SINGLE      - only one employee is assigned, so there is nothing to compare
 *   NOT_STARTED - two employees are assigned but nobody has sent a count yet
 *   PENDING     - two employees are assigned but at least one has not submitted yet
 *   AGREED      - both submitted and their numbers match
 *   CONFLICT    - both submitted and their numbers differ; the owner decides
 */
type CountAgreement = "SINGLE" | "NOT_STARTED" | "PENDING" | "AGREED" | "CONFLICT";

/** Statuses a counter row can be in before the owner resolves a conflict. */
type CountStatus = "PENDING" | "SUBMITTED";

type AuditItemInput = {
  assignedToUserId?: unknown;
  /** The second employee assigned to the same row. Both count it independently. */
  secondCounterUserId?: unknown;
  variantId?: unknown;
  lotItemId?: unknown;
};

type CreateAuditBody = {
  auditCode?: unknown;
  note?: unknown;
  /** Rows created by the owner: employee + variant + lot. */
  items?: unknown;
  /** What the audit covers: FULL_STORE, CATEGORY or SHELF. */
  scopeType?: unknown;
  /** The category the audit covers. Only used when scopeType is CATEGORY. */
  categoryId?: unknown;
  /** The shelf position the audit covers. Only used when scopeType is SHELF. */
  shelfCellId?: unknown;
};

type AssignItemsBody = {
  items?: unknown;
};

type ReassignItemBody = {
  assignedToUserId?: unknown;
  /** The second employee, when the owner asks for a second count on the row. */
  secondCounterUserId?: unknown;
};

type RecordCountBody = {
  variantId?: unknown;
  lotItemId?: unknown;
  countedQty?: unknown;
};

type UpdateCountBody = {
  countedQty?: unknown;
  /** Broken goods found during the count. The total (usable + broken) is derived, never sent. */
  countedDamagedQty?: unknown;
  discrepancyReason?: unknown;
  /** Existing lot item: lot number and expiry are autofilled from product_lot_items. */
  lotItemId?: unknown;
  /** Correction of the lot's expiry / manufacturing date. */
  newLotExpirationDate?: unknown;
  newLotManufacturingDate?: unknown;
};

type SubmitItemBody = {
  discrepancyReason?: unknown;
};

type RejectItemBody = {
  reason?: unknown;
};

type AuditListQuery = {
  status?: string;
  page?: number;
  pageSize?: number;
  /** The caller. A draft is only visible to the owner, so the viewer decides what is listed. */
  authUserId: string;
};

type AuditItemsQuery = {
  page?: number;
  pageSize?: number;
  /** When true, only items assigned to the calling user are returned. */
  mine?: boolean;
};

async function resolveUser(authUserId: string) {
  const user = await prisma.user.findUnique({ where: { authUserId } });
  if (!user || user.status !== "ACTIVE") {
    throw new HttpError(403, "Tài khoản chưa được đồng bộ với cửa hàng.");
  }
  return user;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Generated audit codes are per business and year: AUDIT_2026_0001. */
async function nextAuditCode(businessId: string) {
  const prefix = `AUDIT_${new Date().getFullYear()}_`;
  const last = await prisma.stockAudit.findFirst({
    where: { businessId, auditCode: { startsWith: prefix } },
    orderBy: { auditCode: "desc" },
    select: { auditCode: true },
  });
  const sequence = last?.auditCode ? Number(last.auditCode.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(Number.isFinite(sequence) ? sequence : 1).padStart(4, "0")}`;
}

type DbClient = Prisma.TransactionClient | typeof prisma;

/** Select used wherever a full audit item (with product, lot and people) is returned. */
const AUDIT_ITEM_SELECT = {
  id: true,
  variantId: true,
  lotItemId: true,
  lotNumber: true,
  newLotExpirationDate: true,
  newLotManufacturingDate: true,
  auditId: true,
  snapshotQty: true,
  countedQty: true,
  countedDamagedQty: true,
  diffQty: true,
  discrepancyReason: true,
  itemStatus: true,
  assignedToUserId: true,
  secondCounterUserId: true,
  submittedAt: true,
  submittedBy: true,
  approvedAt: true,
  approvedBy: true,
  rejectionReason: true,
  rejectedAt: true,
  rejectedBy: true,
  createdBy: true,
  variant: {
    select: {
      sku: true,
      template: { select: { name: true, imageUrl: true } },
      variantAttributeValues: {
        include: {
          attribute: { select: { name: true } },
          attributeValue: { select: { value: true } },
        },
      },
    },
  },
  lotItem: {
    select: {
      id: true,
      variantId: true,
      expirationDate: true,
      manufacturingDate: true,
      lot: { select: { id: true, lotNumber: true } },
      // Where the goods physically sit, so the counters know which shelf they have to walk to.
      shelfCell: {
        select: {
          id: true,
          level: true,
          slot: true,
          shelf: { select: { id: true, code: true, name: true } },
        },
      },
    },
  },
  assignedToUser: { select: { id: true, fullName: true, email: true } },
  secondCounterUser: { select: { id: true, fullName: true, email: true } },
  createdByUser: { select: { id: true, fullName: true, email: true } },
  submittedByUser: { select: { id: true, fullName: true, email: true } },
  approvedByUser: { select: { id: true, fullName: true, email: true } },
  rejectedByUser: { select: { id: true, fullName: true, email: true } },
  counts: {
    select: {
      id: true,
      counterUserId: true,
      countedQty: true,
      countedDamagedQty: true,
      discrepancyReason: true,
      newLotExpirationDate: true,
      newLotManufacturingDate: true,
      submittedAt: true,
      counterUser: { select: { id: true, fullName: true, email: true } },
      images: {
        // Only the photos still part of the live gallery. A filed photo belongs to a history
        // entry, so it is no longer the row's evidence: keeping it here would make the client
        // render a placeholder for every photo of an already-decided round.
        where: { deletedAt: null, archivedAt: null, historyId: null },
        select: {
          id: true,
          storagePath: true,
          mimeType: true,
          sizeBytes: true,
          uploadedBy: true,
          createdAt: true,
          updatedAt: true,
          uploadedByUser: { select: { id: true, fullName: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.StockAuditItemSelect;

type AuditItemRow = Prisma.StockAuditItemGetPayload<{ select: typeof AUDIT_ITEM_SELECT }>;

const person = (user: { id: string; fullName: string } | null | undefined) =>
  user ? { id: user.id, name: user.fullName } : null;

/**
 * Compare the counters of a row.
 *
 * A row has one counter when the owner assigned a single employee, and two when the owner also
 * assigned a second one. Two counters only agree once both have sent their count, so a half-filled
 * row is PENDING rather than AGREED. A row nobody has finished yet is NOT_STARTED: it is not
 * waiting for anyone in particular, so it must not be shown as waiting for the other counter.
 */
function resolveCountAgreement(
  item: {
    secondCounterUserId: string | null;
    counts: { countedQty: number; countedDamagedQty: number; submittedAt: Date | null }[];
  },
): CountAgreement {
  if (!item.secondCounterUserId) return "SINGLE";
  // Only a count that was sent for approval is finished. A saved but unsent number is still work
  // in progress, so the row is not waiting for anyone yet.
  const sent = item.counts.filter((c) => c.submittedAt);
  // Nobody has sent a count yet: the row is not waiting for anyone in particular.
  if (sent.length === 0) return "NOT_STARTED";
  // One counter sent their number: the row now waits for the other one.
  if (sent.length < 2) return "PENDING";
  const [first, second] = sent;
  // Both the usable quantity and the broken goods must match: two counters who found a
  // different amount of broken goods have not settled the row.
  const sameUsable = first.countedQty === second.countedQty;
  const sameBroken = first.countedDamagedQty === second.countedDamagedQty;
  return sameUsable && sameBroken ? "AGREED" : "CONFLICT";
}

/**
 * Shape an item for one viewer.
 *
 * The owner sees every counter's number so they can compare them. A staff member sees only their
 * own count and never the other counter's, which is what makes the second count blind.
 */
function formatAuditItem(item: AuditItemRow, viewerId?: string | null, viewerIsOwner = false) {
  const counts = item.counts.map((count) => ({
    id: count.id,
    counterUserId: count.counterUserId,
    counter: person(count.counterUser),
    countedQty: count.countedQty,
    countedDamagedQty: count.countedDamagedQty,
    discrepancyReason: count.discrepancyReason,
    newLotExpirationDate: count.newLotExpirationDate,
    newLotManufacturingDate: count.newLotManufacturingDate,
    submittedAt: count.submittedAt,
    /**
     * The photos this counter took of the broken goods. They belong to the count, so the other
     * counter never sees them. The signed links are short-lived; the client refreshes them
     * through GET /audits/:id/items/:itemId/counts/:countId/images when they expire.
     */
    images: (count.images ?? []).map((image) => ({
      id: image.id,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      uploadedBy: image.uploadedBy,
      uploadedByName: image.uploadedByUser.fullName,
      createdAt: image.createdAt,
    })),
  }));

  const visibleCounts = viewerIsOwner
    ? counts
    : counts.filter((count) => count.counterUserId === viewerId);

  return {
    id: item.id,
    variantId: item.variantId,
    sku: item.variant.sku,
    productName: item.variant.template.name,
    imageUrl: item.variant.template.imageUrl,
    attributeText: item.variant.variantAttributeValues
      .map((v) => v.attributeValue.value)
      .join(" · "),
    lotId: item.lotItem?.lot.id ?? null,
    lotItemId: item.lotItem?.id ?? item.lotItemId ?? null,
    // The number comes from the batch the row points at.
    lotNumber: item.lotItem?.lot.lotNumber ?? item.lotNumber ?? null,
    // Dates typed by the employee win: they are a correction that is written to the lot item
    // when the audit is applied.
    expirationDate: item.newLotExpirationDate ?? item.lotItem?.expirationDate ?? null,
    manufacturingDate: item.newLotManufacturingDate ?? item.lotItem?.manufacturingDate ?? null,
    newLotManufacturingDate: item.newLotManufacturingDate ?? null,
    /** What the system currently has on the lot item, to show next to a correction. */
    lotExpirationDate: item.lotItem?.expirationDate ?? null,
    lotManufacturingDate: item.lotItem?.manufacturingDate ?? null,
    /**
     * Where the lot physically sits: "Ke A2 - Tang 3 - O 04". The counters need it to find the
     * goods, so it comes with every row of the count.
     */
    shelfCell: item.lotItem?.shelfCell
      ? {
          id: item.lotItem.shelfCell.id,
          level: item.lotItem.shelfCell.level,
          slot: item.lotItem.shelfCell.slot,
          shelf: item.lotItem.shelfCell.shelf,
        }
      : null,
    /** True when the employee changed an existing lot item's dates. */
    datesCorrected: Boolean(item.lotItemId && (item.newLotExpirationDate || item.newLotManufacturingDate)),
    snapshotQty: item.snapshotQty,
    countedQty: item.countedQty,
    /** Broken goods found during the count. The total (usable + broken) is derived on the client. */
    countedDamagedQty: item.countedDamagedQty,
    diffQty: item.diffQty,
    discrepancyReason: item.discrepancyReason,
    itemStatus: item.itemStatus,
    assignedTo: person(item.assignedToUser),
    /** The second employee assigned to the row, when the owner asked for a second count. */
    secondCounter: person(item.secondCounterUser),
    secondCounterUserId: item.secondCounterUserId,
    /** SINGLE / NOT_STARTED / PENDING / AGREED / CONFLICT. */
    countAgreement: resolveCountAgreement(item),
    /** Every counter of the row. Only the owner receives the full list. */
    counts: visibleCounts,
    /**
     * The row keeps one reason and one broken figure, but two counters each have their own. The
     * owner therefore gets both here: the row's own fields belong to the employee the row was
     * assigned to, and this list carries every counter's reason and broken quantity. A staff
     * member only ever sees their own entry, so the other counter's reason stays hidden.
     */
    counterDetails: visibleCounts.map((count) => ({
      counterUserId: count.counterUserId,
      counter: count.counter,
      discrepancyReason: count.discrepancyReason,
      countedDamagedQty: count.countedDamagedQty,
    })),
    createdBy: person(item.createdByUser),
    submittedBy: person(item.submittedByUser),
    submittedAt: item.submittedAt,
    approvedBy: person(item.approvedByUser),
    approvedAt: item.approvedAt,
    rejectionReason: item.rejectionReason,
    rejectedBy: person(item.rejectedByUser),
    rejectedAt: item.rejectedAt,
  };
}

async function getFormattedItem(
  db: DbClient,
  itemId: string,
  viewerId?: string | null,
  viewerIsOwner = false,
) {
  const item = await db.stockAuditItem.findUnique({
    where: { id: itemId },
    select: AUDIT_ITEM_SELECT,
  });
  if (!item) {
    throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
  }
  return formatAuditItem(item, viewerId, viewerIsOwner);
}

const toDay = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null);

/** A non-empty date string that cannot be parsed is an error; an empty value means "no change". */
function parseOptionalDate(value: unknown, label: string): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = parseDate(value);
  if (!date) {
    throw new HttpError(400, `${label} không hợp lệ.`);
  }
  return date;
}

/** The owner's note on the audit. An empty value means no note. */
function parseNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const note = value.trim();
  if (!note) return null;
  if (note.length > 1000) {
    throw new HttpError(400, "Ghi chú không được dài quá 1000 ký tự.");
  }
  return note;
}

/**
 * For an existing lot: compare the dates sent by the employee with the lot's dates.
 * Returns only the values that differ (null = keep the lot's value), so a correction is stored on the
 * audit item and applied to the lot when the audit is applied.
 */
function resolveLotDateCorrection(
  lot: { expirationDate: Date; manufacturingDate: Date | null },
  body: UpdateCountBody,
) {
  const sentExpiration = parseOptionalDate(body.newLotExpirationDate, "Hạn sử dụng");
  const sentManufacturing = parseOptionalDate(body.newLotManufacturingDate, "Ngày sản xuất");

  const expiration =
    sentExpiration && toDay(sentExpiration) !== toDay(lot.expirationDate) ? sentExpiration : null;
  const manufacturing =
    sentManufacturing && toDay(sentManufacturing) !== toDay(lot.manufacturingDate)
      ? sentManufacturing
      : null;

  const effectiveExpiration = expiration ?? lot.expirationDate;
  const effectiveManufacturing = manufacturing ?? lot.manufacturingDate;
  if (effectiveManufacturing && effectiveManufacturing > effectiveExpiration) {
    throw new HttpError(400, "Ngày sản xuất không được sau hạn sử dụng.");
  }

  return { expiration, manufacturing };
}

/** True when the user is an OWNER of the business (not a STAFF member). */
async function isBusinessOwner(db: DbClient, businessId: string, userId: string) {
  const membership = await db.businessMembership.findFirst({
    where: { businessId, userId, status: "ACTIVE" },
    select: { role: { select: { code: true } } },
  });
  return membership?.role.code === "OWNER";
}

/** The owner alone may start, cancel or delete an audit. */
async function assertBusinessOwner(db: DbClient, businessId: string, userId: string) {
  if (!(await isBusinessOwner(db, businessId, userId))) {
    throw new HttpError(403, "Chỉ chủ cửa hàng mới được thao tác đợt kiểm kê này.");
  }
}

/**
 * Free the SKUs an audit was holding when it ends.
 *
 * A SKU that another running audit still holds stays locked: that audit still needs it. Both
 * the variants and the lot items are handled the same way, so an audit can never unlock a
 * stock another audit is counting.
 */
async function releaseAuditLocks(
  tx: Prisma.TransactionClient,
  businessId: string,
  auditId: string,
  variantIds: string[],
  lotItemIds: string[],
) {
  if (variantIds.length === 0 && lotItemIds.length === 0) return;

  const heldVariants = new Set<string>();
  const heldLotItems = new Set<string>();

  const filters: Prisma.StockAuditItemWhereInput[] = [];
  if (variantIds.length > 0) filters.push({ variantId: { in: variantIds } });
  if (lotItemIds.length > 0) filters.push({ lotItemId: { in: lotItemIds } });

  const others = await tx.stockAudit.findMany({
    where: {
      businessId,
      id: { not: auditId },
      isLockedForAudit: true,
      status: { in: ["IN_PROGRESS", "PENDING_APPROVAL"] },
      stockAuditItems: { some: { OR: filters } },
    },
    select: {
      stockAuditItems: {
        where: { OR: filters },
        select: { variantId: true, lotItemId: true },
      },
    },
  });

  for (const other of others) {
    for (const item of other.stockAuditItems) {
      if (item.variantId) heldVariants.add(item.variantId);
      if (item.lotItemId) heldLotItems.add(item.lotItemId);
    }
  }

  const freeVariants = variantIds.filter((variantId) => !heldVariants.has(variantId));
  if (freeVariants.length > 0) {
    await tx.productVariant.updateMany({
      where: { id: { in: freeVariants } },
      data: { isLockedForAudit: false, updatedAt: new Date() },
    });
  }

  const freeLotItems = lotItemIds.filter((lotItemId) => !heldLotItems.has(lotItemId));
  if (freeLotItems.length > 0) {
    await tx.productLotItem.updateMany({
      where: { id: { in: freeLotItems } },
      data: { isLockedForAudit: false },
    });
  }
}

/**
 * Only one of the row's two counters may count or submit it.
 *
 * The owner never counts: they assign the two counters, compare their numbers and resolve the
 * rows that disagree. Letting the owner count would add a third number nobody is waiting for.
 */
async function assertCanActOnItem(
  db: DbClient,
  businessId: string,
  userId: string,
  assignedToUserId: string | null,
  secondCounterUserId: string | null = null,
) {
  if (assignedToUserId === userId) return;
  if (secondCounterUserId === userId) return;
  if (await isBusinessOwner(db, businessId, userId)) {
    throw new HttpError(403, "Chủ cửa hàng không đếm hộ. Hai người kiểm kê phải tự đếm dòng này.");
  }
  throw new HttpError(403, "Chỉ nhân viên được giao mới thao tác được dòng kiểm kê này.");
}

/** Ensure every assignee is an active STAFF member of this business. */
async function assertAssigneesAreStaff(db: DbClient, businessId: string, userIds: string[]) {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;

  const members = await db.businessMembership.findMany({
    where: {
      businessId,
      userId: { in: unique },
      status: "ACTIVE",
      role: { code: { not: "OWNER" } },
    },
    select: { userId: true },
  });
  const valid = new Set(members.map((m) => m.userId));
  const invalid = unique.filter((id) => !valid.has(id));
  if (invalid.length > 0) {
    throw new HttpError(400, "Người được giao phải là nhân viên (STAFF) đang hoạt động của cửa hàng.");
  }
}

/** Current on-hand quantity for a variant + lot item (0 when there is no balance row). */
async function getSnapshotQty(db: DbClient, businessId: string, variantId: string, lotItemId: string | null) {
  const balance = await db.inventoryBalance.findFirst({
    where: { businessId, variantId, lotItemId },
    select: { quantityOnHand: true },
  });
  return balance?.quantityOnHand ?? 0;
}

type NormalizedRow = {
  /** Null only for a row the scope generated: the owner assigns the counters later. */
  assignedToUserId: string | null;
  /** The second employee. Every row is counted by two people. */
  secondCounterUserId: string | null;
  variantId: string;
  lotItemId: string;
};

/**
 * Scrap orders that still keep a lot out of an audit: one waiting for the Owner, and one the
 * Owner rejected. Both mean the lot's fate is still open. An approved (COMPLETED) or closed
 * (CANCELLED) order is settled, so its lot can be counted again.
 */
const AUDIT_BLOCKING_SCRAP_STATUSES = ["PENDING", "REJECTED"] as const;

/**
 * A lot whose scrap decision is still open must not enter an audit: adding the row locks the
 * variant, which blocks the scrap approval, and the audit application would rewrite the stock
 * the order was judged against. Report the scrap code so the owner knows which order is in the way.
 */
async function findLotsWithOpenScrapOrder(
  db: DbClient,
  businessId: string,
  lotItemIds: string[],
): Promise<Map<string, { scrapCode: string; status: string }>> {
  const blocked = new Map<string, { scrapCode: string; status: string }>();
  if (lotItemIds.length === 0) return blocked;

  const orders = await db.scrapOrder.findMany({
    where: {
      businessId,
      lotItemId: { in: lotItemIds },
      status: { in: [...AUDIT_BLOCKING_SCRAP_STATUSES] },
    },
    select: { lotItemId: true, scrapCode: true, status: true },
    orderBy: { createdAt: "desc" },
  });
  for (const order of orders) {
    if (order.lotItemId && !blocked.has(order.lotItemId)) {
      blocked.set(order.lotItemId, { scrapCode: order.scrapCode, status: order.status });
    }
  }
  return blocked;
}

/**
 * Validate owner-created rows and return them normalized.
 * Checks assignees, variants and lot items, and rejects duplicate (variant, lot item) rows.
 */
async function normalizeAndValidateRows(
  db: DbClient,
  businessId: string,
  rawItems: unknown,
  existing: Array<{ variantId: string; lotItemId: string | null }> = [],
  /**
   * True for the rows a scope generated: nobody has been assigned to them yet, because the
   * owner picks the counters afterwards. Rows the owner typed still need two counters.
   */
  allowUnassigned = false,
): Promise<NormalizedRow[]> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, "Cần ít nhất một dòng kiểm kê (nhân viên + SKU + lô).");
  }

  const rows: NormalizedRow[] = (rawItems as AuditItemInput[]).map((raw, index) => {
    const assignedToUserId = typeof raw?.assignedToUserId === "string" ? raw.assignedToUserId.trim() : "";
    const secondCounterUserId =
      typeof raw?.secondCounterUserId === "string" ? raw.secondCounterUserId.trim() : "";
    const variantId = typeof raw?.variantId === "string" ? raw.variantId.trim() : "";
    const lotItemId =
      typeof raw?.lotItemId === "string" && raw.lotItemId.trim() ? raw.lotItemId.trim() : null;
    if (!assignedToUserId && !allowUnassigned) {
      throw new HttpError(400, `Dòng ${index + 1}: chưa chọn nhân viên.`);
    }
    // Every row is counted twice: the owner always names a second person.
    if (!secondCounterUserId && !allowUnassigned) {
      throw new HttpError(400, `Dòng ${index + 1}: chưa chọn người kiểm kê thứ hai.`);
    }
    // The second counter is a different person: two people counting the same row is the point.
    if (secondCounterUserId && assignedToUserId && secondCounterUserId === assignedToUserId) {
      throw new HttpError(
        400,
        `Dòng ${index + 1}: người kiểm kê thứ hai phải khác người được giao.`,
      );
    }
    if (!variantId) {
      throw new HttpError(400, `Dòng ${index + 1}: chưa chọn SKU.`);
    }
    // Every row counts a lot that is already in the system.
    if (!lotItemId) {
      throw new HttpError(400, `Dòng ${index + 1}: bắt buộc chọn lô có sẵn.`);
    }

    return {
      assignedToUserId: assignedToUserId || null,
      secondCounterUserId: secondCounterUserId || null,
      variantId,
      lotItemId,
    };
  });

  await assertAssigneesAreStaff(db, businessId, [
    ...rows.map((r) => r.assignedToUserId).filter((id): id is string => Boolean(id)),
    ...rows.map((r) => r.secondCounterUserId).filter((id): id is string => Boolean(id)),
  ]);

  const variantIds = [...new Set(rows.map((r) => r.variantId))];
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds }, businessId, isActive: true },
    select: { id: true },
  });
  if (variants.length !== variantIds.length) {
    throw new HttpError(404, "Có SKU không tồn tại hoặc không hoạt động.");
  }

  const lotItemIds = [...new Set(rows.map((r) => r.lotItemId))];
  if (lotItemIds.length > 0) {
    const lotItems = await db.productLotItem.findMany({
      where: { id: { in: lotItemIds }, businessId },
      select: { id: true, variantId: true, status: true, lot: { select: { lotNumber: true } } },
    });
    const itemVariant = new Map(lotItems.map((l) => [l.id, l.variantId]));
    const lotNumberById = new Map(lotItems.map((l) => [l.id, l.lot.lotNumber]));
    for (const row of rows) {
      if (itemVariant.get(row.lotItemId) !== row.variantId) {
        throw new HttpError(400, "Lô không tồn tại hoặc không thuộc SKU đã chọn.");
      }
    }

    // A lot that was already scrapped has no stock left to count, so it never enters an audit.
    const scrapped = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        const item = lotItems.find((l) => l.id === row.lotItemId);
        return item?.status === "SCRAPPED";
      })
      .map(
        ({ row, index }) =>
          `Dòng ${index + 1}: lô ${lotNumberById.get(row.lotItemId) ?? row.lotItemId} đã bị hủy hàng.`,
      )
      .join(" ");
    if (scrapped) {
      throw new HttpError(409, `${scrapped} Lô đã bị hủy hàng thì không thể kiểm kê.`);
    }

    // A lot whose scrap decision is still open cannot be audited: locking the row blocks the
    // scrap approval, and the audit application would rewrite the stock the order was judged
    // against. Report the exact scrap code and status.
    const blocked = await findLotsWithOpenScrapOrder(db, businessId, lotItemIds);
    if (blocked.size > 0) {
      const details = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => blocked.has(row.lotItemId))
        .map(({ row, index }) => {
          const order = blocked.get(row.lotItemId)!;
          return `Dòng ${index + 1}: lô ${lotNumberById.get(row.lotItemId) ?? row.lotItemId} có phiếu hủy ${order.scrapCode} (${scrapStatusLabel(order.status)}).`;
        })
        .join(" ");
      throw new HttpError(
        409,
        `${details} Lô đang có phiếu hủy chưa xong xuất thì không thể đưa vào đợt kiểm kê.`,
      );
    }
  }

  const seen = new Set(existing.filter((e) => e.lotItemId).map((e) => `${e.variantId}:${e.lotItemId}`));
  for (const row of rows) {
    const key = `${row.variantId}:${row.lotItemId}`;
    if (seen.has(key)) {
      throw new HttpError(409, "Có dòng kiểm kê trùng SKU và lô.");
    }
    seen.add(key);
  }

  return rows;
}

/**
 * The rows an audit covers, generated from its scope.
 *
 * The scope columns existed but nothing ever wrote them, so "Theo ke" and "Theo danh muc" were
 * dead options and the owner had to type every row by hand. Now the scope decides the rows:
 * the lots that physically sit on a shelf position, or the lots of a category.
 *
 * The rows come without counters. Nobody can be named here, because the owner does not know yet
 * which employees will count; they assign them on the audit detail page. That is why the rows
 * are allowed to have no assignee.
 */
async function buildRowsFromScope(
  db: DbClient,
  businessId: string,
  scopeType: "CATEGORY" | "SHELF",
  scope: { categoryIds?: string[]; shelfCellId?: string | null },
): Promise<NormalizedRow[]> {
  const where: Prisma.ProductLotItemWhereInput =
    scopeType === "SHELF"
      ? { businessId, shelfCellId: scope.shelfCellId! }
      : {
          businessId,
          variant: { template: { categoryId: { in: scope.categoryIds ?? [] } } },
        };

  const items = await db.productLotItem.findMany({
    where: {
      ...where,
      // A scrapped lot has no stock left to count.
      status: { not: "SCRAPPED" },
      // A lot locked by another audit cannot be counted twice at the same time.
      isLockedForAudit: false,
      // Only the lots that still have stock on hand are worth counting.
      inventoryBalances: { some: { businessId, quantityOnHand: { gt: 0 } } },
    },
    select: { id: true, variantId: true },
    orderBy: { expirationDate: "asc" },
  });

  if (items.length === 0) {
    return [];
  }

  // A lot whose scrap decision is still open stays out of the audit, the same as for a row the
  // owner typed by hand.
  const blocked = await findLotsWithOpenScrapOrder(
    db,
    businessId,
    items.map((item) => item.id),
  );

  return items
    .filter((item) => !blocked.has(item.id))
    .map((item) => ({
      assignedToUserId: null,
      secondCounterUserId: null,
      variantId: item.variantId,
      lotItemId: item.id,
    }));
}

/**
 * Read the scope off the request and check it.
 *
 * The scope decides which rows the audit covers, so a scope that points at nothing is refused
 * here instead of producing an audit with no rows.
 */
async function resolveAuditScope(
  db: DbClient,
  businessId: string,
  body: CreateAuditBody,
): Promise<{
  scopeType: "FULL_STORE" | "CATEGORY" | "SHELF";
  categoryId: string | null;
  shelfCellId: string | null;
}> {
  const requested = String(body.scopeType ?? "FULL_STORE").trim().toUpperCase();
  if (requested !== "FULL_STORE" && requested !== "CATEGORY" && requested !== "SHELF") {
    throw new HttpError(400, "Phạm vi kiểm kê không hợp lệ.");
  }

  if (requested === "FULL_STORE") {
    return { scopeType: "FULL_STORE", categoryId: null, shelfCellId: null };
  }

  if (requested === "SHELF") {
    const shelfCellId = typeof body.shelfCellId === "string" ? body.shelfCellId.trim() : "";
    if (!shelfCellId) {
      throw new HttpError(400, "Hãy chọn ô kệ cần kiểm kê.");
    }
    const cell = await db.inventoryShelfCell.findFirst({
      where: { id: shelfCellId, businessId },
      select: { id: true },
    });
    if (!cell) {
      throw new HttpError(404, "Không tìm thấy ô kệ đã chọn.");
    }
    return { scopeType: "SHELF", categoryId: null, shelfCellId };
  }

  const categoryId = typeof body.categoryId === "string" ? body.categoryId.trim() : "";
  if (!categoryId) {
    throw new HttpError(400, "Hãy chọn danh mục cần kiểm kê.");
  }
  const category = await db.category.findFirst({
    where: { id: categoryId, businessId },
    select: { id: true },
  });
  if (!category) {
    throw new HttpError(404, "Không tìm thấy danh mục đã chọn.");
  }

  return { scopeType: "CATEGORY", categoryId, shelfCellId: null };
}

/**
 * The category ids a scope covers: the category itself plus its children.
 *
 * The category tree is two levels deep, so a parent category covers its children too.
 */
async function resolveCategoryIds(
  db: DbClient,
  businessId: string,
  categoryId: string,
): Promise<string[]> {
  const children = await db.category.findMany({
    where: { businessId, parentId: categoryId },
    select: { id: true },
  });
  return [categoryId, ...children.map((child) => child.id)];
}

/** Build the data for new audit item rows: lot number autofilled, snapshot read from the balance. */
async function buildItemData(
  db: DbClient,
  businessId: string,
  auditId: string,
  createdBy: string,
  rows: NormalizedRow[],
) {
  const lotItemIds = [...new Set(rows.map((r) => r.lotItemId))];
  const lotItems = lotItemIds.length
    ? await db.productLotItem.findMany({
        where: { id: { in: lotItemIds } },
        select: { id: true, lot: { select: { lotNumber: true } } },
      })
    : [];
  const lotNumberById = new Map(lotItems.map((l) => [l.id, l.lot.lotNumber]));

  const data = [];
  for (const row of rows) {
    data.push({
      auditId,
      variantId: row.variantId,
      lotItemId: row.lotItemId,
      lotNumber: lotNumberById.get(row.lotItemId) ?? null,
      snapshotQty: await getSnapshotQty(db, businessId, row.variantId, row.lotItemId),
      countedQty: 0,
      itemStatus: "IN_PROGRESS",
      assignedToUserId: row.assignedToUserId,
      secondCounterUserId: row.secondCounterUserId,
      createdBy,
    });
  }
  return data;
}

class AuditService {
  async createAudit(businessId: string, authUserId: string, body: CreateAuditBody) {
    const user = await resolveUser(authUserId);

    // The code is generated for the caller; an explicitly provided code is still accepted.
    const providedCode = typeof body.auditCode === "string" ? body.auditCode.trim() : "";
    const auditType = "RE_AUDIT";
    const note = parseNote(body.note);

    const auditCode = providedCode || (await nextAuditCode(businessId));

    // Check if audit code is unique per business
    const existing = await prisma.stockAudit.findFirst({
      where: { businessId, auditCode },
    });
    if (existing) {
      throw new HttpError(409, `Mã kiểm kê "${auditCode}" đã tồn tại trong cửa hàng này.`);
    }

    // The scope decides which rows the audit covers. It was written to the database but never
    // read, so "Theo ke" and "Theo danh muc" were dead options.
    const scope = await resolveAuditScope(prisma, businessId, body);

    // Items are added in a separate step from the audit detail page, so they are optional here.
    // When rows are provided (employee + variant + optional lot), they are validated and created too.
    const hasRows = Array.isArray(body.items) && body.items.length > 0;
    let rows = hasRows
      ? await normalizeAndValidateRows(prisma, businessId, body.items)
      : [];

    // A scoped audit gets its rows from the stock itself: the lots on the shelf position, or the
    // lots of the category. The rows come without counters, because the owner assigns them on
    // the audit detail page.
    if (!hasRows && scope.scopeType !== "FULL_STORE") {
      rows =
        scope.scopeType === "SHELF"
          ? await buildRowsFromScope(prisma, businessId, "SHELF", {
              shelfCellId: scope.shelfCellId,
            })
          : await buildRowsFromScope(prisma, businessId, "CATEGORY", {
              categoryIds: await resolveCategoryIds(prisma, businessId, scope.categoryId!),
            });
    }

    const affectedVariantIds = [...new Set(rows.map((r) => r.variantId))];

    // Create the audit and the owner-defined rows in one transaction. A draft locks nothing:
    // the SKUs are locked when the owner starts the counting, so a misconfigured audit can still
    // be deleted without freezing the store's stock.
    const audit = await prisma.$transaction(async (tx) => {
      const created = await tx.stockAudit.create({
        data: {
          businessId,
          auditCode,
          auditType,
          status: "DRAFT",
          isLockedForAudit: false,
          // The count has not started: the date is written when the owner starts the audit.
          countStartAt: null,
          createdBy: user.id,
          note,
          scopeType: scope.scopeType,
          categoryId: scope.categoryId,
          shelfCellId: scope.shelfCellId,
        },
        select: {
          id: true,
          auditCode: true,
          scopeType: true,
          auditType: true,
          status: true,
          isLockedForAudit: true,
          countStartAt: true,
          note: true,
        },
      });

      if (rows.length > 0) {
        // The snapshot is read again when the audit starts, because the draft may sit for a while
        // and the stock it compares against is the stock of that moment. The value written here is
        // only a placeholder for a draft that is never started.
        const itemData = await buildItemData(tx, businessId, created.id, user.id, rows);

        await tx.stockAuditItem.createMany({ data: itemData });
      }

      return created;
    }, { timeout: 30000 });

    return {
      id: audit.id,
      auditCode: audit.auditCode,
      scopeType: audit.scopeType,
      auditType: audit.auditType,
      status: audit.status,
      isLockedForAudit: audit.isLockedForAudit,
      countStartAt: audit.countStartAt,
      note: audit.note,
      itemCount: rows.length,
      affectedVariantCount: affectedVariantIds.length,
    };
  }

  /**
   * Owner: start the counting of a draft.
   *
   * This is the moment the SKUs are locked and the snapshot is taken, so both happen here and not
   * when the draft is written: a draft may sit for a while, and the stock it compares against is
   * the stock of the moment counting starts.
   */
  async startAudit(businessId: string, authUserId: string, auditId: string) {
    const user = await resolveUser(authUserId);
    await assertBusinessOwner(prisma, businessId, user.id);

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      select: {
        id: true,
        status: true,
        stockAuditItems: {
          select: {
            id: true,
            variantId: true,
            lotItemId: true,
            assignedToUserId: true,
            secondCounterUserId: true,
          },
        },
      },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    if (audit.status !== "DRAFT") {
      throw new HttpError(409, "Chỉ đợt kiểm kê ở trạng thái Nháp mới bắt đầu kiểm kê được.");
    }

    if (audit.stockAuditItems.length === 0) {
      throw new HttpError(400, "Đợt kiểm kê chưa có dòng nào. Hãy thêm dòng rồi bắt đầu.");
    }

    // Every row is counted by two people, so a row without counters cannot be counted. The rows
    // a scope generated have none: the owner assigns them on the audit detail page, and the
    // counting only starts once every row has its two people.
    const unassigned = audit.stockAuditItems.filter(
      (item) => !item.assignedToUserId || !item.secondCounterUserId,
    );
    if (unassigned.length > 0) {
      throw new HttpError(
        400,
        `Còn ${unassigned.length} dòng chưa gán đủ 2 người kiểm kê. Hãy gán nhân viên cho các dòng này rồi bắt đầu.`,
      );
    }

    // The draft may have been sitting for a while: the lot may have been scrapped, or a scrap
    // order may have been opened on it since the row was written. The same validation the rows
    // went through when they were added is run again before the counting starts.
    const rows = await normalizeAndValidateRows(
      prisma,
      businessId,
      audit.stockAuditItems.map((item) => ({
        assignedToUserId: item.assignedToUserId,
        secondCounterUserId: item.secondCounterUserId,
        variantId: item.variantId,
        lotItemId: item.lotItemId,
      })),
      [],
    );

    const variantIds = [...new Set(rows.map((r) => r.variantId))];
    const lotItemIds = [...new Set(rows.map((r) => r.lotItemId))];

    const started = await prisma.$transaction(async (tx) => {
      // The snapshot is read now, so the audit compares against the stock of this moment.
      for (const item of audit.stockAuditItems) {
        await tx.stockAuditItem.update({
          where: { id: item.id },
          data: {
            snapshotQty: await getSnapshotQty(tx, businessId, item.variantId, item.lotItemId),
          },
        });
      }

      // From now on the SKUs are frozen: no sale, purchase, scrap or return may move them.
      await tx.productVariant.updateMany({
        where: { id: { in: variantIds } },
        data: { isLockedForAudit: true, updatedAt: new Date() },
      });

      if (lotItemIds.length > 0) {
        await tx.productLotItem.updateMany({
          where: { id: { in: lotItemIds } },
          data: { isLockedForAudit: true },
        });
      }

      return tx.stockAudit.update({
        where: { id: auditId },
        data: {
          status: "IN_PROGRESS",
          countStartAt: new Date(),
          isLockedForAudit: true,
        },
        select: {
          id: true,
          auditCode: true,
          status: true,
          isLockedForAudit: true,
          countStartAt: true,
        },
      });
    }, { timeout: 30000 });

    return {
      id: started.id,
      auditCode: started.auditCode,
      status: started.status,
      isLockedForAudit: started.isLockedForAudit,
      countStartAt: started.countStartAt,
    };
  }

  /**
   * Owner: delete a draft.
   *
   * Only a draft can be deleted. A running audit has already been counted, so it can only be
   * cancelled. The rows go with the audit through the cascade; the files in storage are collected
   * before the delete, because afterwards the rows that hold their paths are gone.
   */
  async deleteAudit(businessId: string, authUserId: string, auditId: string) {
    const user = await resolveUser(authUserId);
    await assertBusinessOwner(prisma, businessId, user.id);

    const paths = await prisma.$transaction(async (tx) => {
      const audit = await tx.stockAudit.findFirst({
        where: { id: auditId, businessId },
        select: { id: true, status: true },
      });

      if (!audit) {
        throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
      }

      if (audit.status !== "DRAFT") {
        throw new HttpError(409, "Chỉ đợt kiểm kê ở trạng thái Nháp mới xoá được. Đợt đang chạy thì hãy huỷ.");
      }

      // Includes soft-deleted photos: once the audit is gone nothing refers to their files.
      const images = await tx.stockAuditItemCountImage.findMany({
        where: { businessId, count: { item: { auditId } } },
        select: { storagePath: true },
      });

      await tx.stockAudit.delete({ where: { id: auditId } });
      return images.map((image) => image.storagePath);
    });

    // After commit and best effort: a storage hiccup must not undo the delete.
    await deleteObjects(paths);
  }

  /**
   * Owner: remove one row from a draft.
   *
   * The row's counts and their photos go with it through the cascade; the files in storage are
   * collected before the delete.
   */
  async deleteAuditItem(businessId: string, authUserId: string, auditId: string, itemId: string) {
    const user = await resolveUser(authUserId);
    await assertBusinessOwner(prisma, businessId, user.id);

    const paths = await prisma.$transaction(async (tx) => {
      const audit = await tx.stockAudit.findFirst({
        where: { id: auditId, businessId },
        select: { id: true, status: true },
      });

      if (!audit) {
        throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
      }

      if (audit.status !== "DRAFT") {
        throw new HttpError(409, "Chỉ sửa được dòng của đợt kiểm kê ở trạng thái Nháp.");
      }

      const item = await tx.stockAuditItem.findFirst({
        where: { id: itemId, auditId },
        select: { id: true },
      });

      if (!item) {
        throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
      }

      const images = await tx.stockAuditItemCountImage.findMany({
        where: { businessId, count: { itemId } },
        select: { storagePath: true },
      });

      await tx.stockAuditItem.delete({ where: { id: itemId } });
      return images.map((image) => image.storagePath);
    });

    // After commit and best effort: a storage hiccup must not undo the delete.
    await deleteObjects(paths);
  }

  /**
   * Owner: cancel a running audit.
   *
   * A running audit cannot be deleted, only cancelled: its rows and their counts are a record of
   * what was counted. Cancelling frees the SKUs again, which is why it is done here - a locked
   * SKU blocks every sale, purchase, scrap and return of that stock.
   */
  async cancelAudit(businessId: string, authUserId: string, auditId: string) {
    const user = await resolveUser(authUserId);
    await assertBusinessOwner(prisma, businessId, user.id);

    const cancelled = await prisma.$transaction(async (tx) => {
      const audit = await tx.stockAudit.findFirst({
        where: { id: auditId, businessId },
        select: {
          id: true,
          status: true,
          stockAuditItems: { select: { variantId: true, lotItemId: true } },
        },
      });

      if (!audit) {
        throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
      }

      if (audit.status !== "IN_PROGRESS") {
        throw new HttpError(409, "Chỉ đợt kiểm kê đang chạy mới huỷ được.");
      }

      const variantIds = [...new Set(audit.stockAuditItems.map((item) => item.variantId))];
      const lotItemIds = [
        ...new Set(
          audit.stockAuditItems
            .map((item) => item.lotItemId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];

      // A SKU that another running audit also holds stays locked: that audit still needs it.
      await releaseAuditLocks(tx, businessId, auditId, variantIds, lotItemIds);

      return tx.stockAudit.update({
        where: { id: auditId },
        data: { status: "CANCELLED", isLockedForAudit: false, completedAt: new Date() },
        select: { id: true, auditCode: true, status: true, completedAt: true },
      });
    }, { timeout: 30000 });

    return {
      id: cancelled.id,
      auditCode: cancelled.auditCode,
      status: cancelled.status,
      completedAt: cancelled.completedAt,
    };
  }

  async listAudits(businessId: string, params: AuditListQuery) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(params.pageSize) || 10));
    const status = String(params.status ?? "").trim().toUpperCase();

    const viewer = await resolveUser(params.authUserId);
    const viewerIsOwner = await isBusinessOwner(prisma, businessId, viewer.id);

    const where: Prisma.StockAuditWhereInput = { businessId };
    if (["DRAFT", "IN_PROGRESS", "DONE", "CANCELLED"].includes(status)) {
      // A draft is a preparation the owner makes before counting starts, so staff never see it.
      if (status === "DRAFT" && !viewerIsOwner) {
        where.status = "__no_draft__";
      } else {
        where.status = status;
      }
    } else if (!viewerIsOwner) {
      where.status = { not: "DRAFT" };
    }

    const [audits, total] = await Promise.all([
      prisma.stockAudit.findMany({
        where,
        include: {
          approvedByUser: { select: { fullName: true, email: true } },
          stockAuditItems: { select: { id: true } },
          category: { select: { id: true, name: true } },
          shelfCell: { select: { id: true, level: true, slot: true, shelf: { select: { code: true } } } },
        },
        // A draft has no start date yet, so it sorts by its code instead of by a null date.
        orderBy: [{ countStartAt: { sort: "desc", nulls: "last" } }, { auditCode: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.stockAudit.count({ where }),
    ]);

    return {
      items: audits.map((audit) => ({
        id: audit.id,
        auditCode: audit.auditCode,
        scopeType: audit.scopeType,
        status: audit.status,
        itemCount: audit.stockAuditItems.length,
        isLockedForAudit: audit.isLockedForAudit,
        countStartAt: audit.countStartAt,
        completedAt: audit.completedAt,
        note: audit.note,
        approvedBy: audit.approvedByUser?.fullName || audit.approvedByUser?.email || null,
        categoryName: audit.category?.name ?? null,
        shelfLabel: audit.shelfCell
          ? `Kệ ${audit.shelfCell.shelf.code} - Tầng ${audit.shelfCell.level} - Ô ${audit.shelfCell.slot}`
          : null,
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  async getAudit(businessId: string, authUserId: string, auditId: string) {
    const viewer = await resolveUser(authUserId);
    const viewerIsOwner = await isBusinessOwner(prisma, businessId, viewer.id);

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      include: {
        business: { select: { industryType: true } },
        approvedByUser: { select: { fullName: true, email: true } },
        createdByUser: { select: { id: true, fullName: true, email: true } },
        category: { select: { id: true, name: true } },
        shelfCell: { select: { id: true, level: true, slot: true, shelf: { select: { code: true } } } },
        stockAuditItems: {
          select: AUDIT_ITEM_SELECT,
          orderBy: { id: "asc" },
        },
      },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    // A draft is the owner's own preparation, so staff never see it.
    if (audit.status === "DRAFT" && !viewerIsOwner) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    return {
      id: audit.id,
      auditCode: audit.auditCode,
      scopeType: audit.scopeType,
      auditType: audit.auditType,
      status: audit.status,
      isLockedForAudit: audit.isLockedForAudit,
      countStartAt: audit.countStartAt,
      completedAt: audit.completedAt,
      note: audit.note,
      industryType: audit.business?.industryType || null,
      approvedBy: audit.approvedByUser?.fullName || audit.approvedByUser?.email || null,
      createdBy: person(audit.createdByUser),
      itemCount: audit.stockAuditItems.length,
      categoryName: audit.category?.name ?? null,
      shelfLabel: audit.shelfCell
        ? `Kệ ${audit.shelfCell.shelf.code} - Tầng ${audit.shelfCell.level} - Ô ${audit.shelfCell.slot}`
        : null,
      items: audit.stockAuditItems.map((item) => formatAuditItem(item, viewer.id, viewerIsOwner)),
    };
  }

  /**
   * Record a count against a row the owner already created.
   * This no longer creates rows: the owner defines employee + variant + lot up front.
   */
  async recordCount(businessId: string, authUserId: string, auditId: string, body: RecordCountBody) {
    const user = await resolveUser(authUserId);
    const variantId = typeof body.variantId === "string" ? body.variantId.trim() : "";
    const lotItemId = typeof body.lotItemId === "string" && body.lotItemId.trim() ? body.lotItemId.trim() : null;
    const countedQty = Math.trunc(Number(body.countedQty));

    if (!variantId) {
      throw new HttpError(400, "SKU không được trống.");
    }

    if (!Number.isFinite(countedQty) || countedQty < 0) {
      throw new HttpError(400, "Số lượng đếm phải lớn hơn hoặc bằng 0.");
    }

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    if (audit.status !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể ghi nhận số đếm khi đợt kiểm kê đang IN_PROGRESS.");
    }

    const candidates = await prisma.stockAuditItem.findMany({
      where: { auditId, variantId, lotItemId },
      select: { id: true, assignedToUserId: true, secondCounterUserId: true },
    });
    const item =
      candidates.find((c) => c.assignedToUserId === user.id || c.secondCounterUserId === user.id) ??
      candidates[0];

    if (!item) {
      throw new HttpError(
        404,
        "Không có dòng kiểm kê cho SKU/lô này. Chủ cửa hàng cần tạo dòng và giao cho nhân viên trước.",
      );
    }

    await assertCanActOnItem(
      prisma,
      businessId,
      user.id,
      item.assignedToUserId,
      item.secondCounterUserId,
    );

    // The count goes into the caller's own slot so the other counter never sees it.
    await prisma.stockAuditItemCount.upsert({
      where: { itemId_counterUserId: { itemId: item.id, counterUserId: user.id } },
      create: { itemId: item.id, counterUserId: user.id, countedQty },
      update: { countedQty, submittedAt: null },
    });

    await this.syncAgreedCount(prisma, businessId, item.id, user.id);

    return getFormattedItem(prisma, item.id, user.id, false);
  }

  /** Owner: add more employee + variant + lot rows to a draft or a running audit. */
  async addAuditItems(businessId: string, authUserId: string, auditId: string, body: AssignItemsBody) {
    const user = await resolveUser(authUserId);
    await assertBusinessOwner(prisma, businessId, user.id);

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      select: { id: true, status: true, auditType: true },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    // A draft is where the owner builds the rows, so they can be added then too.
    if (audit.status !== "DRAFT" && audit.status !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể thêm dòng khi đợt kiểm kê đang Nháp hoặc IN_PROGRESS.");
    }

    const existing = await prisma.stockAuditItem.findMany({
      where: { auditId },
      select: { variantId: true, lotItemId: true },
    });
    const rows = await normalizeAndValidateRows(prisma, businessId, body.items, existing);
    const variantIds = [...new Set(rows.map((r) => r.variantId))];

    await prisma.$transaction(async (tx) => {
      // A draft locks nothing: the SKUs are frozen when the counting starts.
      if (audit.status === "IN_PROGRESS") {
        await tx.productVariant.updateMany({
          where: { id: { in: variantIds } },
          data: { isLockedForAudit: true, updatedAt: new Date() },
        });

        const lotItemIds = rows.map((r) => r.lotItemId);
        if (lotItemIds.length > 0) {
          await tx.productLotItem.updateMany({
            where: { id: { in: lotItemIds } },
            data: { isLockedForAudit: true },
          });
        }
      }

      const itemData = await buildItemData(tx, businessId, auditId, user.id, rows);
      await tx.stockAuditItem.createMany({ data: itemData });
    }, { timeout: 30000 });

    return { added: rows.length };
  }

  /** Owner: reassign an item to a different employee, and set the second counter. */
  async reassignAuditItem(
    businessId: string,
    authUserId: string,
    auditId: string,
    itemId: string,
    body: ReassignItemBody,
  ) {
    const user = await resolveUser(authUserId);
    await assertBusinessOwner(prisma, businessId, user.id);

    const assignedToUserId =
      typeof body.assignedToUserId === "string" ? body.assignedToUserId.trim() : "";
    if (!assignedToUserId) {
      throw new HttpError(400, "Chưa chọn nhân viên.");
    }

    // Every row is counted twice, so the owner always names a second person.
    const secondCounterUserId =
      typeof body.secondCounterUserId === "string" ? body.secondCounterUserId.trim() : "";
    if (!secondCounterUserId) {
      throw new HttpError(400, "Chưa chọn người kiểm kê thứ hai.");
    }

    if (secondCounterUserId === assignedToUserId) {
      throw new HttpError(400, "Người kiểm kê thứ hai phải khác người được giao.");
    }

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      select: { status: true },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    // A draft is where the owner builds the rows, so they can be changed then too.
    if (audit.status !== "DRAFT" && audit.status !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể đổi người được giao khi đợt kiểm kê đang Nháp hoặc IN_PROGRESS.");
    }

    const item = await prisma.stockAuditItem.findFirst({
      where: { id: itemId, auditId },
      select: { id: true, itemStatus: true },
    });

    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }

    if (item.itemStatus !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể đổi người được giao cho dòng đang IN_PROGRESS.");
    }

    await assertAssigneesAreStaff(prisma, businessId, [assignedToUserId, secondCounterUserId]);

    await prisma.stockAuditItem.update({
      where: { id: itemId },
      data: { assignedToUserId, secondCounterUserId },
    });

    // Changing the people means the old counts no longer belong to this row's counters.
    await prisma.stockAuditItemCount.deleteMany({
      where: { itemId, counterUserId: { notIn: [assignedToUserId, secondCounterUserId] } },
    });

    return getFormattedItem(prisma, itemId, user.id, true);
  }

  async updateCount(
    businessId: string,
    authUserId: string,
    auditId: string,
    itemId: string,
    body: UpdateCountBody,
    files?: { buffer: Buffer }[],
  ) {
    const user = await resolveUser(authUserId);
    const countedQty = Math.trunc(Number(body.countedQty));
    // Broken goods are counted separately from the usable quantity; the total is derived.
    const countedDamagedQty =
      body.countedDamagedQty === undefined || body.countedDamagedQty === null
        ? 0
        : Math.trunc(Number(body.countedDamagedQty));
    const discrepancyReason =
      typeof body.discrepancyReason === "string" ? body.discrepancyReason.trim().slice(0, 1000) : null;

    if (!Number.isFinite(countedQty) || countedQty < 0) {
      throw new HttpError(400, "Số lượng đếm phải lớn hơn hoặc bằng 0.");
    }
    if (!Number.isFinite(countedDamagedQty) || countedDamagedQty < 0) {
      throw new HttpError(400, "Số lượng hàng hỏng phải lớn hơn hoặc bằng 0.");
    }

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    if (audit.status !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể cập nhật số đếm khi đợt kiểm kê đang IN_PROGRESS.");
    }

    const item = await prisma.stockAuditItem.findFirst({
      where: { id: itemId, auditId },
      select: {
        id: true,
        variantId: true,
        lotItemId: true,
        lotNumber: true,
        newLotExpirationDate: true,
        newLotManufacturingDate: true,
        snapshotQty: true,
        itemStatus: true,
        assignedToUserId: true,
        secondCounterUserId: true,
      },
    });

    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }

    await assertCanActOnItem(
      prisma,
      businessId,
      user.id,
      item.assignedToUserId,
      item.secondCounterUserId,
    );

    if (item.itemStatus !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể sửa dòng đang IN_PROGRESS.");
    }

    // The row keeps the lot the owner assigned: the employee counts it and may correct its dates,
    // but cannot switch the lot or create a new one.
    const lotData: {
      newLotExpirationDate?: Date | null;
      newLotManufacturingDate?: Date | null;
    } = {};
    let snapshotQty = item.snapshotQty;

    const lotItemId =
      typeof body.lotItemId === "string" && body.lotItemId.trim() ? body.lotItemId.trim() : null;

    if (body.lotItemId !== undefined && lotItemId !== item.lotItemId) {
      throw new HttpError(400, "Không được đổi lô của dòng kiểm kê.");
    }

    // The employee may correct a wrong expiry / manufacturing date. Only differences from the lot item
    // are stored; the lot item itself is updated when the owner applies the audit.
    if (item.lotItemId) {
      const lotItem = await prisma.productLotItem.findFirst({
        where: { id: item.lotItemId, businessId, variantId: item.variantId },
        select: {
          id: true,
          expirationDate: true,
          manufacturingDate: true,
          lot: { select: { lotNumber: true } },
        },
      });
      if (!lotItem) {
        throw new HttpError(404, "Lô không tồn tại hoặc không thuộc SKU của dòng này.");
      }

      const correction = resolveLotDateCorrection(lotItem, body);

      lotData.newLotExpirationDate = correction.expiration;
      lotData.newLotManufacturingDate = correction.manufacturing;
      snapshotQty = await getSnapshotQty(prisma, businessId, item.variantId, lotItem.id);
    }

    // Every counted row requires a discrepancy reason, whether or not quantities differ
    if (!discrepancyReason) {
      throw new HttpError(400, "Bắt buộc nhập lý do chênh lệch.");
    }

    // Broken goods are documented with photos, so the owner can see what was found.
    const preparedImages = imageService.prepareImages(files);

    if (countedDamagedQty > 0 && preparedImages.length === 0) {
      throw new HttpError(
        400,
        "Khi phát hiện hàng hỏng, bắt buộc có ít nhất một ảnh bằng chứng.",
      );
    }

    // Each employee's count lives in their own row, so the other counter never sees it.
    const count = await prisma.stockAuditItemCount.upsert({
      where: { itemId_counterUserId: { itemId, counterUserId: user.id } },
      create: {
        itemId,
        counterUserId: user.id,
        countedQty,
        countedDamagedQty,
        discrepancyReason,
        ...lotData,
      },
      update: {
        countedQty,
        countedDamagedQty,
        discrepancyReason,
        ...lotData,
        // Editing a submitted count pulls it back so the owner compares the latest numbers.
        submittedAt: null,
      },
    });

    // The photos are stored next to the count they belong to. The files go up first; when the
    // database write fails the uploaded objects are removed again.
    await this.saveCountImages(businessId, auditId, count.id, user.id, preparedImages);

    // The row keeps the agreed figure: the shared number once both counters agree, otherwise the
    // single count while there is only one counter.
    await this.syncAgreedCount(prisma, businessId, itemId, user.id);

    return getFormattedItem(prisma, itemId, user.id, false);
  }

  /**
   * Store the evidence photos of one count.
   *
   * The files are uploaded before the rows are written, so a failed upload never leaves a row
   * pointing at a file that is not there. When the write fails the uploaded objects are deleted
   * again; the cleanup is best effort and never hides the original error.
   */
  private async saveCountImages(
    businessId: string,
    auditId: string,
    countId: string,
    userId: string,
    images: PreparedAuditImage[],
  ): Promise<void> {
    if (images.length === 0) return;

    const storedImages = images.map((image) => ({
      ...image,
      storagePath: `${businessId}/audits/${auditId}/${countId}/${randomUUID()}.${image.extension}`,
    }));

    const uploadedPaths: string[] = [];
    try {
      for (const image of storedImages) {
        await uploadObject(image.storagePath, image.buffer, image.mimeType);
        uploadedPaths.push(image.storagePath);
      }
    } catch (error) {
      await deleteObjects(uploadedPaths);
      throw error;
    }

    try {
      await prisma.stockAuditItemCountImage.createMany({
        data: storedImages.map((image) => ({
          businessId,
          countId,
          storagePath: image.storagePath,
          mimeType: image.mimeType,
          sizeBytes: image.buffer.length,
          uploadedBy: userId,
        })),
      });
    } catch (error) {
      await deleteObjects(uploadedPaths);
      throw error;
    }
  }

  /**
   * Write the row's agreed figure from the counters' own numbers.
   *
   * With one counter, the row shows that number. With two, the row only takes a number once both
   * counters agree, so the owner never sees a half-filled row as if it were settled.
   */
  private async syncAgreedCount(db: DbClient, businessId: string, itemId: string, actorId: string) {
    const item = await db.stockAuditItem.findFirst({
      where: { id: itemId },
      select: {
        id: true,
        variantId: true,
        lotItemId: true,
        secondCounterUserId: true,
        counts: {
          select: { counterUserId: true, countedQty: true, countedDamagedQty: true, submittedAt: true },
        },
      },
    });
    if (!item) return;

    if (!item.secondCounterUserId) {
      const own = item.counts.find((c) => c.counterUserId === actorId);
      if (!own) return;
      await db.stockAuditItem.update({
        where: { id: itemId },
        data: { countedQty: own.countedQty, countedDamagedQty: own.countedDamagedQty },
      });
      return;
    }

    if (item.counts.length < 2) return;
    if (item.counts.some((c) => !c.submittedAt)) return;
    const [first, second] = item.counts;
    if (first.countedQty !== second.countedQty) return;
    if (first.countedDamagedQty !== second.countedDamagedQty) return;

    await db.stockAuditItem.update({
      where: { id: itemId },
      data: { countedQty: first.countedQty, countedDamagedQty: first.countedDamagedQty },
    });
  }

  /**
   * Record what the row looked like at the moment the owner decided something.
   *
   * The record is a copy of the numbers, so the history does not change when the live row does.
   * Each counter's own number is copied too, otherwise the history would only say that the row
   * was sent back, not what the two people had found.
   *
   * The evidence photos are filed under the record: they keep their count (so only the counter who
   * took them and the owner may read them) but they leave the live gallery, so old evidence never
   * sits next to fresh numbers.
   *
   * This must run before the numbers are cleared, otherwise the snapshot would be empty.
   */
  private async recordItemHistory(
    db: DbClient,
    businessId: string,
    itemId: string,
    action: "APPROVED" | "REJECTED" | "RECOUNT",
    actorId: string,
    reason: string | null,
  ) {
    const item = await db.stockAuditItem.findFirst({
      where: { id: itemId, audit: { businessId } },
      select: {
        id: true,
        auditId: true,
        snapshotQty: true,
        countedQty: true,
        countedDamagedQty: true,
        discrepancyReason: true,
        counts: {
          select: {
            id: true,
            counterUserId: true,
            countedQty: true,
            countedDamagedQty: true,
            discrepancyReason: true,
            submittedAt: true,
          },
        },
      },
    });
    if (!item) return;

    // The nth time this row was recorded. The pair (item, revision) is unique.
    const last = await db.stockAuditItemHistory.findFirst({
      where: { itemId },
      orderBy: { revision: "desc" },
      select: { revision: true, createdAt: true },
    });
    const revision = (last?.revision ?? 0) + 1;

    const history = await db.stockAuditItemHistory.create({
      data: {
        businessId,
        itemId: item.id,
        auditId: item.auditId,
        revision,
        action,
        reason,
        actorId,
        snapshotQty: item.snapshotQty,
        countedQty: item.countedQty,
        countedDamagedQty: item.countedDamagedQty,
        discrepancyReason: item.discrepancyReason,
        counts: {
          create: item.counts.map((count) => ({
            counterUserId: count.counterUserId,
            countedQty: count.countedQty,
            countedDamagedQty: count.countedDamagedQty,
            discrepancyReason: count.discrepancyReason,
            submittedAt: count.submittedAt,
          })),
        },
      },
      select: { id: true },
    });

    // The photos taken since the last decision now belong to this moment.
    //
    // The count rows are reused: a rejected row is counted again on the same rows, so the count
    // id alone does not tell which round a photo came from. The time of the previous decision
    // does. A photo taken after that moment belongs to this round; a photo already filed under an
    // earlier entry keeps its entry.
    const countIds = item.counts.map((count) => count.id);
    if (countIds.length > 0) {
      await db.stockAuditItemCountImage.updateMany({
        where: {
          businessId,
          countId: { in: countIds },
          deletedAt: null,
          archivedAt: null,
          historyId: null,
          ...(last?.createdAt ? { createdAt: { gt: last.createdAt } } : {}),
        },
        data: { historyId: history.id, archivedAt: new Date() },
      });
    }
  }

  async submitAuditItem(
    businessId: string,
    authUserId: string,
    auditId: string,
    itemId: string,
    body: SubmitItemBody,
  ) {
    const user = await resolveUser(authUserId);

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    if (audit.status !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể submit item khi đợt kiểm kê đang IN_PROGRESS.");
    }

    const item = await prisma.stockAuditItem.findFirst({
      where: { id: itemId, auditId },
      select: {
        id: true,
        auditId: true,
        variantId: true,
        lotItemId: true,
        lotNumber: true,
        newLotExpirationDate: true,
        snapshotQty: true,
        countedQty: true,
        diffQty: true,
        discrepancyReason: true,
        itemStatus: true,
        assignedToUserId: true,
        secondCounterUserId: true,
        submittedAt: true,
        submittedBy: true,
        approvedAt: true,
        approvedBy: true,
      },
    });

    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }

    // Only an assigned employee or the owner (on behalf) may submit
    await assertCanActOnItem(
      prisma,
      businessId,
      user.id,
      item.assignedToUserId,
      item.secondCounterUserId,
    );

    // Every item must point at a lot in the system. The expiry is optional: clothes have no shelf life.
    if (!item.lotItemId) {
      throw new HttpError(400, "Dòng kiểm kê chưa có lô. Hãy báo chủ cửa hàng xử lý.");
    }

    // The employee submits their own count. With two counters, the row is only ready for the owner
    // once both numbers are in and they match; a disagreement waits for the owner's decision.
    const ownCount = await prisma.stockAuditItemCount.findUnique({
      where: { itemId_counterUserId: { itemId, counterUserId: user.id } },
      select: { countedQty: true, discrepancyReason: true },
    });

    if (!ownCount) {
      throw new HttpError(400, "Bạn chưa nhập số đếm cho dòng này.");
    }

    // Every item requires a discrepancy reason before it can be submitted
    if (!ownCount.discrepancyReason) {
      throw new HttpError(400, "Bắt buộc nhập lý do chênh lệch trước khi nộp.");
    }

    // Validate item is in IN_PROGRESS state
    if (item.itemStatus !== "IN_PROGRESS") {
      throw new HttpError(409, "Dòng kiểm kê không còn ở trạng thái IN_PROGRESS.");
    }

    await prisma.stockAuditItemCount.update({
      where: { itemId_counterUserId: { itemId, counterUserId: user.id } },
      data: { submittedAt: new Date() },
    });

    // A row with two counters waits for the second number. Only when both are in and they agree
    // does the row move on to the owner for approval.
    const counters = await prisma.stockAuditItemCount.findMany({
      where: { itemId },
      select: {
        counterUserId: true,
        countedQty: true,
        countedDamagedQty: true,
        submittedAt: true,
      },
    });

    const needsTwoCounters = Boolean(item.secondCounterUserId);
    const bothSubmitted =
      counters.length >= 2 && counters.every((c) => Boolean(c.submittedAt));
    // The broken goods count too: two counters who found a different amount of broken goods have
    // not settled the row, even when the usable quantity matches.
    const agree =
      counters.length >= 2 &&
      counters[0].countedQty === counters[1].countedQty &&
      counters[0].countedDamagedQty === counters[1].countedDamagedQty;

    if (needsTwoCounters && !bothSubmitted) {
      // The owner's number goes on the row once it is settled; until then the row keeps waiting.
      await this.syncAgreedCount(prisma, businessId, itemId, user.id);
      return getFormattedItem(prisma, itemId, user.id, false);
    }

    if (needsTwoCounters && !agree) {
      // The two numbers differ: the row stays in progress until the owner sends it back.
      await this.syncAgreedCount(prisma, businessId, itemId, user.id);
      return getFormattedItem(prisma, itemId, user.id, false);
    }

    // The row's own fields carry the agreed figure so the owner approves one number.
    // They belong to the employee the row was assigned to, so the owner always sees the same
    // reason and broken figure no matter who submitted last.
    const primary =
      counters.find((c) => c.counterUserId === item.assignedToUserId) ?? counters[0];
    const primaryRow = primary
      ? await prisma.stockAuditItemCount.findUnique({
          where: { itemId_counterUserId: { itemId, counterUserId: primary.counterUserId } },
          select: { countedQty: true, countedDamagedQty: true, discrepancyReason: true },
        })
      : null;
    // The lot dates are the submitter's own correction, so they keep coming from their count.
    const ownCountRow = await prisma.stockAuditItemCount.findUnique({
      where: { itemId_counterUserId: { itemId, counterUserId: user.id } },
      select: {
        countedQty: true,
        countedDamagedQty: true,
        discrepancyReason: true,
        newLotExpirationDate: true,
        newLotManufacturingDate: true,
      },
    });

    await prisma.stockAuditItem.update({
      where: { id: itemId },
      data: {
        itemStatus: "PENDING_APPROVAL",
        submittedAt: new Date(),
        submittedBy: user.id,
        countedQty: primaryRow?.countedQty ?? ownCountRow?.countedQty ?? 0,
        countedDamagedQty: primaryRow?.countedDamagedQty ?? ownCountRow?.countedDamagedQty ?? 0,
        discrepancyReason: primaryRow?.discrepancyReason ?? null,
        ...(ownCountRow?.newLotExpirationDate
          ? { newLotExpirationDate: ownCountRow.newLotExpirationDate }
          : {}),
        ...(ownCountRow?.newLotManufacturingDate
          ? { newLotManufacturingDate: ownCountRow.newLotManufacturingDate }
          : {}),
        // A new submission answers any earlier rejection
        rejectionReason: null,
        rejectedAt: null,
        rejectedBy: null,
      },
    });

    return getFormattedItem(prisma, itemId, user.id, false);
  }

  /** Owner: send a submitted item back to the employee for a recount, with a required reason. */
  async rejectAuditItem(
    businessId: string,
    authUserId: string,
    auditId: string,
    itemId: string,
    body: RejectItemBody,
  ) {
    const user = await resolveUser(authUserId);

    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      throw new HttpError(400, "Cần nhập lý do khi từ chối dòng kiểm kê.");
    }
    if (reason.length > 1000) {
      throw new HttpError(400, "Lý do từ chối tối đa 1000 ký tự.");
    }

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      select: { id: true, status: true },
    });
    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }
    if (audit.status !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể từ chối item khi đợt kiểm kê đang IN_PROGRESS.");
    }

    const item = await prisma.stockAuditItem.findFirst({
      where: { id: itemId, auditId },
      select: { id: true, itemStatus: true },
    });
    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }
    if (item.itemStatus !== "PENDING_APPROVAL") {
      throw new HttpError(409, "Chỉ có thể từ chối item đang ở trạng thái PENDING_APPROVAL.");
    }

    // The history is written before the numbers are cleared, so it keeps what was counted.
    await this.recordItemHistory(prisma, businessId, itemId, "REJECTED", user.id, reason);

    await prisma.stockAuditItem.update({
      where: { id: itemId },
      data: {
        itemStatus: "IN_PROGRESS",
        rejectionReason: reason,
        rejectedAt: new Date(),
        rejectedBy: user.id,
        submittedAt: null,
        submittedBy: null,
      },
    });

    // A rejected row is counted again, so the previous numbers no longer count as submitted.
    await prisma.stockAuditItemCount.updateMany({
      where: { itemId },
      data: { submittedAt: null },
    });

    return getFormattedItem(prisma, itemId, user.id, true);
  }

  /**
   * Owner: the two counters did not agree, so send the row back to both for another count.
   *
   * The row keeps its two counters; both have to count again before it moves on. This is the
   * owner's only way out of a disagreement, which is what keeps the decision with the owner.
   */
  async requestRecount(
    businessId: string,
    authUserId: string,
    auditId: string,
    itemId: string,
    body: RejectItemBody,
  ) {
    const user = await resolveUser(authUserId);

    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      throw new HttpError(400, "Cần nhập lý do khi yêu cầu kiểm kê lại.");
    }
    if (reason.length > 1000) {
      throw new HttpError(400, "Lý do tối đa 1000 ký tự.");
    }

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      select: { id: true, status: true },
    });
    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }
    if (audit.status !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể yêu cầu kiểm kê lại khi đợt kiểm kê đang IN_PROGRESS.");
    }

    const item = await prisma.stockAuditItem.findFirst({
      where: { id: itemId, auditId },
      select: {
        id: true,
        itemStatus: true,
        secondCounterUserId: true,
        counts: {
          select: {
            counterUserId: true,
            countedQty: true,
            countedDamagedQty: true,
            submittedAt: true,
          },
        },
      },
    });
    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }
    if (!item.secondCounterUserId) {
      throw new HttpError(409, "Dòng này chỉ có một người kiểm kê nên không cần kiểm kê lại.");
    }

    // Only a row whose two counters actually disagree needs a recount. The broken goods count as a
    // difference too: they change the stock the owner approves.
    const submitted = item.counts.filter((c) => c.submittedAt);
    const sameUsable = submitted[0]?.countedQty === submitted[1]?.countedQty;
    const sameBroken = submitted[0]?.countedDamagedQty === submitted[1]?.countedDamagedQty;
    if (submitted.length < 2 || (sameUsable && sameBroken)) {
      throw new HttpError(409, "Hai người kiểm kê đang có cùng số liệu nên không cần kiểm kê lại.");
    }

    // The history is written before the numbers are cleared, so it keeps what was counted.
    await this.recordItemHistory(prisma, businessId, itemId, "RECOUNT", user.id, reason);

    // Both counters start over: the old numbers are cleared so neither number can be mistaken
    // for the new one.
    await prisma.stockAuditItemCount.updateMany({
      where: { itemId },
      data: { submittedAt: null, countedQty: 0, countedDamagedQty: 0 },
    });

    await prisma.stockAuditItem.update({
      where: { id: itemId },
      data: {
        itemStatus: "IN_PROGRESS",
        rejectionReason: reason,
        rejectedAt: new Date(),
        rejectedBy: user.id,
        submittedAt: null,
        submittedBy: null,
        countedQty: 0,
        countedDamagedQty: 0,
        discrepancyReason: null,
      },
    });

    return getFormattedItem(prisma, itemId, user.id, true);
  }

  async approveAuditItem(
    businessId: string,
    authUserId: string,
    auditId: string,
    itemId: string,
  ) {
    const user = await resolveUser(authUserId);

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      include: { stockAuditItems: true },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    if (audit.status !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể approve item khi đợt kiểm kê đang IN_PROGRESS.");
    }

    const item = await prisma.stockAuditItem.findFirst({
      where: { id: itemId, auditId },
      select: {
        id: true,
        auditId: true,
        variantId: true,
        lotItemId: true,
        snapshotQty: true,
        countedQty: true,
        diffQty: true,
        discrepancyReason: true,
        itemStatus: true,
        assignedToUserId: true,
        submittedAt: true,
        submittedBy: true,
        approvedAt: true,
        approvedBy: true,
      },
    });

    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }

    if (item.itemStatus !== "PENDING_APPROVAL") {
      throw new HttpError(409, "Chỉ có thể approve item đang ở trạng thái PENDING_APPROVAL.");
    }

    // The history is written before the row is approved, so it keeps the numbers as they were.
    await this.recordItemHistory(prisma, businessId, itemId, "APPROVED", user.id, null);

    // Approve the item
    const updated = await prisma.stockAuditItem.update({
      where: { id: itemId },
      data: {
        itemStatus: "APPROVED",
        approvedAt: new Date(),
        approvedBy: user.id,
      },
      select: {
        id: true,
        itemStatus: true,
        approvedAt: true,
        approvedBy: true,
      },
    });

    // Check if all items in the audit are now APPROVED
    const remainingPendingItems = await prisma.stockAuditItem.count({
      where: {
        auditId,
        itemStatus: { not: "APPROVED" },
      },
    });

    // If all items approved, auto-apply the audit
    if (remainingPendingItems === 0) {
      await this.applyAudit(businessId, authUserId, auditId);
    }

    return {
      id: updated.id,
      itemStatus: updated.itemStatus,
      approvedAt: updated.approvedAt,
      approvedBy: updated.approvedBy,
      auditAutoApplied: remainingPendingItems === 0,
    };
  }

  async getAuditItems(
    businessId: string,
    authUserId: string,
    auditId: string,
    params: AuditItemsQuery,
  ) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 20));

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      select: { status: true, business: { select: { industryType: true } } },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    const viewer = await resolveUser(authUserId);
    const viewerIsOwner = await isBusinessOwner(prisma, businessId, viewer.id);

    // A draft is the owner's own preparation, so staff never see it.
    if (audit.status === "DRAFT" && !viewerIsOwner) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    // The count page asks for "mine": only items the caller is assigned to, counting as either
    // of the two employees.
    let where: Prisma.StockAuditItemWhereInput = { auditId };
    if (params.mine) {
      where = {
        auditId,
        OR: [{ assignedToUserId: viewer.id }, { secondCounterUserId: viewer.id }],
      };
    }

    const [items, total] = await Promise.all([
      prisma.stockAuditItem.findMany({
        where,
        select: AUDIT_ITEM_SELECT,
        orderBy: { id: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.stockAuditItem.count({ where }),
    ]);

    return {
      industryType: audit.business?.industryType || null,
      items: items.map((item) => formatAuditItem(item, viewer.id, viewerIsOwner)),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  /** Read one item of an audit. Used by the per-item count page. */
  async getAuditItem(businessId: string, authUserId: string, auditId: string, itemId: string) {
    const viewer = await resolveUser(authUserId);
    const viewerIsOwner = await isBusinessOwner(prisma, businessId, viewer.id);

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      select: { id: true, status: true, business: { select: { industryType: true } } },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    // A draft is the owner's own preparation, so staff never see it.
    if (audit.status === "DRAFT" && !viewerIsOwner) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }

    const item = await prisma.stockAuditItem.findFirst({
      where: { id: itemId, auditId, audit: { businessId } },
      select: AUDIT_ITEM_SELECT,
    });

    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }

    const formattedItem = formatAuditItem(item, viewer.id, viewerIsOwner);
    return { ...formattedItem, industryType: audit.business?.industryType || null };
  }

  /**
   * The history of one row: what was counted each time the owner decided something.
   *
   * Only the owner reads it. The history holds what the two counters found, so a staff member
   * must not see it: that would break the blind count.
   */
  async getItemHistory(businessId: string, authUserId: string, auditId: string, itemId: string) {
    const user = await resolveUser(authUserId);
    await assertBusinessOwner(prisma, businessId, user.id);

    const item = await prisma.stockAuditItem.findFirst({
      where: { id: itemId, auditId, audit: { businessId } },
      select: { id: true },
    });
    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }

    const histories = await prisma.stockAuditItemHistory.findMany({
      where: { businessId, itemId },
      orderBy: { revision: "desc" },
      select: {
        id: true,
        revision: true,
        action: true,
        reason: true,
        createdAt: true,
        snapshotQty: true,
        countedQty: true,
        countedDamagedQty: true,
        discrepancyReason: true,
        actor: { select: { id: true, fullName: true, email: true } },
        counts: {
          select: {
            id: true,
            counterUserId: true,
            countedQty: true,
            countedDamagedQty: true,
            discrepancyReason: true,
            submittedAt: true,
            counterUser: { select: { id: true, fullName: true, email: true } },
          },
        },
        images: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });

    // The photos of every moment are signed in one go, so the page needs a single request.
    const imagesByHistory = await imageService.listImagesForHistories(
      businessId,
      histories.map((history) => history.id),
    );

    return histories.map((history) => ({
      id: history.id,
      revision: history.revision,
      action: history.action,
      reason: history.reason,
      createdAt: history.createdAt,
      snapshotQty: history.snapshotQty,
      countedQty: history.countedQty,
      countedDamagedQty: history.countedDamagedQty,
      discrepancyReason: history.discrepancyReason,
      actor: person(history.actor),
      counts: history.counts.map((count) => ({
        id: count.id,
        counterUserId: count.counterUserId,
        counter: person(count.counterUser),
        countedQty: count.countedQty,
        countedDamagedQty: count.countedDamagedQty,
        discrepancyReason: count.discrepancyReason,
        submittedAt: count.submittedAt,
      })),
      images: imagesByHistory.get(history.id) ?? [],
    }));
  }

  /**
   * Owner: close the audit and write the counted stock to the inventory.
   *
   * The route stays, but the work is done by `applyAudit`: closing an audit without applying it
   * would leave the counted stock unwritten and the SKUs locked for good - the audit could not be
   * applied afterwards (it needs IN_PROGRESS), not cancelled (it needs IN_PROGRESS either) and
   * not deleted (it needs DRAFT).
   */
  async approveAudit(businessId: string, authUserId: string, auditId: string) {
    const user = await resolveUser(authUserId);
    await assertBusinessOwner(prisma, businessId, user.id);

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      select: {
        id: true,
        auditCode: true,
        status: true,
        stockAuditItems: {
          select: {
            id: true,
            discrepancyReason: true,
            itemStatus: true,
          },
        },
      },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    if (audit.status !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể phê duyệt đợt kiểm kê đang IN_PROGRESS.");
    }

    if (audit.stockAuditItems.length === 0) {
      throw new HttpError(400, "Đợt kiểm kê chưa có dòng kiểm kê nào.");
    }

    // Only a row the owner has approved may be written to the stock.
    const nonApprovedItems = audit.stockAuditItems.filter((item) => item.itemStatus !== "APPROVED");

    if (nonApprovedItems.length > 0) {
      throw new HttpError(
        400,
        `${nonApprovedItems.length} dòng kiểm kê chưa được duyệt. Yêu cầu tất cả dòng phải ở trạng thái APPROVED.`,
      );
    }

    // Validate: every item must have a discrepancy reason
    for (const item of audit.stockAuditItems) {
      if (!item.discrepancyReason) {
        throw new HttpError(
          400,
          `Dòng kiểm kê ${item.id} chưa có lý do chênh lệch. Bắt buộc nhập lý do trước khi phê duyệt.`,
        );
      }
    }

    const applied = await this.applyAudit(businessId, authUserId, auditId);

    return {
      id: applied.id,
      auditCode: applied.auditCode,
      status: applied.status,
      approvedBy: user.fullName || user.email,
    };
  }

  async applyAudit(businessId: string, authUserId: string, auditId: string) {
    const user = await resolveUser(authUserId);
    await assertBusinessOwner(prisma, businessId, user.id);
    const lotStatusService = new LotStatusService();

    return prisma.$transaction(async (tx) => {
      // Two applies running side by side would write the counted stock twice: the row is locked
      // so the second request waits and then sees the audit is already DONE.
      await tx.$queryRaw`
        SELECT id FROM stock_audits
         WHERE id = ${auditId}::uuid AND business_id = ${businessId}::uuid
         FOR UPDATE
      `;

      const audit = await tx.stockAudit.findFirst({
        where: { id: auditId, businessId },
        select: {
          id: true,
          auditCode: true,
          status: true,
          auditType: true,
          stockAuditItems: {
            select: {
              id: true,
              variantId: true,
              lotItemId: true,
              lotNumber: true,
              newLotExpirationDate: true,
              newLotManufacturingDate: true,
              auditId: true,
              snapshotQty: true,
              countedQty: true,
              countedDamagedQty: true,
              diffQty: true,
              discrepancyReason: true,
              itemStatus: true,
              variant: { select: { costPrice: true } },
              lotItem: {
                select: {
                  id: true,
                  lotId: true,
                  expirationDate: true,
                  manufacturingDate: true,
                  status: true,
                },
              },
            },
          },
        },
      });

      if (!audit) {
        throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
      }

      if (audit.status === "DONE") {
        // Idempotent - already applied
        return { id: audit.id, auditCode: audit.auditCode, status: audit.status };
      }

      if (audit.status !== "IN_PROGRESS") {
        throw new HttpError(409, "Chỉ có thể áp dụng đợt kiểm kê đang IN_PROGRESS.");
      }

      if (audit.stockAuditItems.length === 0) {
        throw new HttpError(400, "Đợt kiểm kê chưa có dòng kiểm kê nào để áp dụng.");
      }

      // Only a row the owner has approved may be written to the stock. A row nobody counted
      // still carries countedQty = 0, so applying it would zero the stock.
      const notApproved = audit.stockAuditItems.filter((item) => item.itemStatus !== "APPROVED");
      if (notApproved.length > 0) {
        throw new HttpError(
          409,
          `${notApproved.length} dòng kiểm kê chưa được duyệt. Chỉ áp dụng được các dòng đã ở trạng thái APPROVED.`,
        );
      }

      // Every row must say why it differs from the snapshot, so the ledger entry can be read.
      for (const item of audit.stockAuditItems) {
        if (!item.discrepancyReason) {
          throw new HttpError(
            400,
            `Dòng kiểm kê ${item.id} chưa có lý do chênh lệch. Bắt buộc nhập lý do trước khi áp dụng.`,
          );
        }
      }

      // A scrap order that is still open is judged against the stock this apply is about to
      // rewrite, so the lot has to be free of one first. Approved and closed orders are settled
      // and do not block the audit.
      const countedLotItemIds = audit.stockAuditItems
        .map((item) => item.lotItemId)
        .filter((id): id is string => Boolean(id));
      if (countedLotItemIds.length > 0) {
        const scrapOrder = await tx.scrapOrder.findFirst({
          where: {
            businessId,
            lotItemId: { in: countedLotItemIds },
            status: { in: [...AUDIT_BLOCKING_SCRAP_STATUSES] },
          },
          orderBy: { createdAt: "desc" },
          select: { scrapCode: true, status: true },
        });
        if (scrapOrder) {
          throw new HttpError(
            409,
            `Lô hàng được kiểm kê đang có phiếu hủy ${scrapOrder.scrapCode} (${scrapStatusLabel(scrapOrder.status)}). ` +
              "Hãy xử lý phiếu hủy đó trước khi áp dụng.",
          );
        }
      }

      // Get all affected variants for unlocking
      const affectedVariantIds = audit.stockAuditItems.map((item) => item.variantId);

      // Apply each audit item
      const ledgerEntries = [];
      
      for (const item of audit.stockAuditItems) {
        // The lot item this row is applied to. Every row points at a lot that is already in the system.
        const lotItemId: string | null = item.lotItemId;

        // Step 1: Update the lot item the employee corrected during the count.
        if (item.lotItem) {
          // Existing lot item. The employee may have corrected its expiry / manufacturing date during the count.
          const correctedExpiration = item.newLotExpirationDate;
          const correctedManufacturing = item.newLotManufacturingDate;
          const hasCorrection = Boolean(correctedExpiration || correctedManufacturing);

          const expirationDate = correctedExpiration ?? item.lotItem.expirationDate;
          const recalculatedStatus = lotStatusService.calculateStatus(expirationDate);
          const wasQuarantined = item.lotItem.status === "QUARANTINED";
          const wasScrapped = item.lotItem.status === "SCRAPPED";
          // A re-audit releases a quarantine only when the lot is sellable again. Expiry alone never
          // releases a quarantine, and a scrap decision is never undone.
          const releasesQuarantine =
            hasCorrection &&
            wasQuarantined &&
            (recalculatedStatus === "HEALTHY" || recalculatedStatus === "WARNING");
          const keepsStatus = wasScrapped || (wasQuarantined && !releasesQuarantine);

          await tx.productLotItem.update({
            where: { id: item.lotItem.id },
            data: {
              ...(correctedExpiration ? { expirationDate: correctedExpiration } : {}),
              ...(correctedManufacturing ? { manufacturingDate: correctedManufacturing } : {}),
              ...(keepsStatus ? {} : { status: recalculatedStatus }),
              // Releasing a quarantine must not leave a HEALTHY row still carrying a quarantine quantity.
              ...(releasesQuarantine
                ? { quarantineQty: null, quarantinedAt: null, quarantinedBy: null, quarantineNote: null }
                : {}),
            },
          });
        }

        // Step 2: Update or create inventory_balance
        const balance = await tx.inventoryBalance.findFirst({
          where: {
            businessId,
            variantId: item.variantId,
            lotItemId,
          },
        });

        if (balance) {
          await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: {
              quantityOnHand: item.countedQty,
              // The count replaced the stock, so the broken goods replace the damaged bucket too.
              // Adding to it would count the same broken goods twice.
              damagedQuantity: item.countedDamagedQty,
              updatedAt: new Date(),
            },
          });
        } else {
          await tx.inventoryBalance.create({
            data: {
              businessId,
              variantId: item.variantId,
              lotItemId,
              quantityOnHand: item.countedQty,
              damagedQuantity: item.countedDamagedQty,
            },
          });
        }

        // Step 3: Create ledger entry if diff != 0
        const diffQty = item.countedQty - item.snapshotQty;
        if (diffQty !== 0) {
          // The enum only has STOCK_ADJUSTMENT_IN / STOCK_ADJUSTMENT_OUT
          const transactionType =
            diffQty > 0
              ? StockTransactionType.STOCK_ADJUSTMENT_IN
              : StockTransactionType.STOCK_ADJUSTMENT_OUT;
          const costPrice = item.variant.costPrice;

          const totalBalance = await tx.inventoryBalance.aggregate({
            where: { businessId, variantId: item.variantId },
            _sum: { quantityOnHand: true },
          });

          ledgerEntries.push({
            businessId,
            variantId: item.variantId,
            lotItemId,
            transactionType,
            quantityChanged: diffQty,
            balanceAfter: totalBalance._sum.quantityOnHand ?? item.countedQty,
            unitCost: costPrice,
            totalCostValue: new Prisma.Decimal(num(costPrice) * Math.abs(diffQty)),
            referenceDocType: "STOCK_AUDIT",
            referenceDocId: audit.id,
            createdBy: user.id,
          });
        }
      }

      // Create all ledger entries
      if (ledgerEntries.length > 0) {
        await tx.inventoryLedger.createMany({ data: ledgerEntries });
      }

      // Unlock the SKUs this audit was holding. A SKU another running audit still holds stays
      // locked: that audit still needs it.
      const affectedLotItemIds = [
        ...new Set(
          audit.stockAuditItems
            .map((item) => item.lotItemId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      await releaseAuditLocks(tx, businessId, auditId, affectedVariantIds, affectedLotItemIds);

      // Mark audit as DONE
      const applied = await tx.stockAudit.update({
        where: { id: auditId },
        data: {
          status: "DONE",
          completedAt: new Date(),
          isLockedForAudit: false,
          approvedBy: user.id,
        },
        select: {
          id: true,
          auditCode: true,
          status: true,
          auditType: true,
        },
      });

      return {
        id: applied.id,
        auditCode: applied.auditCode,
        status: applied.status,
        auditType: applied.auditType,
        itemsApplied: audit.stockAuditItems.length,
        ledgerEntriesCreated: ledgerEntries.length,
      };
    }, { timeout: 60000 });
  }
}

export const auditService = new AuditService();
