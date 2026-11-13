import { Prisma, StockTransactionType } from "@prisma/client";

import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../../shared/http/http-error";
import { LotStatusService } from "./lot-status.service";
import { scrapStatusLabel } from "./scrap-access";

const num = (value: unknown) => Number(value ?? 0);

/** What the employee counts: a lot already in the system, or a lot that does not exist yet. */
type LotMode = "EXISTING" | "NEW";

type AuditItemInput = {
  assignedToUserId?: unknown;
  variantId?: unknown;
  lotItemId?: unknown;
  lotMode?: unknown;
};

type CreateAuditBody = {
  auditCode?: unknown;
  auditType?: unknown;
  note?: unknown;
  /** Rows created by the owner: employee + variant + optional lot. */
  items?: unknown;
};

type AssignItemsBody = {
  items?: unknown;
};

type ReassignItemBody = {
  assignedToUserId?: unknown;
};

type RecordCountBody = {
  variantId?: unknown;
  lotItemId?: unknown;
  countedQty?: unknown;
};

type UpdateCountBody = {
  countedQty?: unknown;
  discrepancyReason?: unknown;
  /** Existing lot item: lot number and expiry are autofilled from product_lot_items. */
  lotItemId?: unknown;
  /** Lot that does not exist yet: typed by the employee. */
  newLotNumber?: unknown;
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
  lotMode: true,
  newLotExpirationDate: true,
  newLotManufacturingDate: true,
  auditId: true,
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
    },
  },
  assignedToUser: { select: { id: true, fullName: true, email: true } },
  createdByUser: { select: { id: true, fullName: true, email: true } },
  submittedByUser: { select: { id: true, fullName: true, email: true } },
  approvedByUser: { select: { id: true, fullName: true, email: true } },
  rejectedByUser: { select: { id: true, fullName: true, email: true } },
} satisfies Prisma.StockAuditItemSelect;

type AuditItemRow = Prisma.StockAuditItemGetPayload<{ select: typeof AUDIT_ITEM_SELECT }>;

const person = (user: { id: string; fullName: string } | null | undefined) =>
  user ? { id: user.id, name: user.fullName } : null;

function formatAuditItem(item: AuditItemRow) {
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
    // Existing lot item: the number comes from the batch. New lot: number typed by the employee.
    lotNumber: item.lotItem?.lot.lotNumber ?? item.lotNumber ?? null,
    // Dates typed by the employee win: for a new lot they are the lot item's dates, for an existing lot
    // they are a correction that is written to the lot item when the audit is applied.
    expirationDate: item.newLotExpirationDate ?? item.lotItem?.expirationDate ?? null,
    manufacturingDate: item.newLotManufacturingDate ?? item.lotItem?.manufacturingDate ?? null,
    newLotManufacturingDate: item.newLotManufacturingDate ?? null,
    /** What the system currently has on the lot item, to show next to a correction. */
    lotExpirationDate: item.lotItem?.expirationDate ?? null,
    lotManufacturingDate: item.lotItem?.manufacturingDate ?? null,
    /** True when the employee changed an existing lot item's dates. */
    datesCorrected: Boolean(item.lotItemId && (item.newLotExpirationDate || item.newLotManufacturingDate)),
    /** Task type set by the owner. The employee cannot switch it. */
    lotMode: item.lotMode as LotMode,
    isNewLot: item.lotMode === "NEW",
    snapshotQty: item.snapshotQty,
    countedQty: item.countedQty,
    diffQty: item.diffQty,
    discrepancyReason: item.discrepancyReason,
    itemStatus: item.itemStatus,
    assignedTo: person(item.assignedToUser),
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

async function getFormattedItem(db: DbClient, itemId: string) {
  const item = await db.stockAuditItem.findUnique({
    where: { id: itemId },
    select: AUDIT_ITEM_SELECT,
  });
  if (!item) {
    throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
  }
  return formatAuditItem(item);
}

const toDay = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null);

const hasLotDateFields = (body: UpdateCountBody) =>
  body.newLotExpirationDate !== undefined || body.newLotManufacturingDate !== undefined;

/** A non-empty date string that cannot be parsed is an error; an empty value means "no change". */
function parseOptionalDate(value: unknown, label: string): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = parseDate(value);
  if (!date) {
    throw new HttpError(400, `${label} không hợp lệ.`);
  }
  return date;
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

/** Only the assigned employee or the business owner may count or submit an item. */
async function assertCanActOnItem(
  db: DbClient,
  businessId: string,
  userId: string,
  assignedToUserId: string | null,
) {
  if (assignedToUserId === userId) return;
  if (await isBusinessOwner(db, businessId, userId)) return;
  throw new HttpError(403, "Chỉ nhân viên được giao hoặc chủ cửa hàng mới thao tác được dòng kiểm kê này.");
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
  assignedToUserId: string;
  variantId: string;
  lotItemId: string | null;
  lotMode: LotMode;
};

/** The audit type decides which kind of lot an item row may point at. */
function assertLotMatchesAuditType(auditType: string, lotItemId: string | null, prefix = "") {
  if (auditType === "NEW_LOTS" && lotItemId) {
    throw new HttpError(400, `${prefix}Đợt kiểm kê lô mới không được chọn lô có sẵn.`);
  }
  if (auditType === "RE_AUDIT" && !lotItemId) {
    throw new HttpError(400, `${prefix}Đợt kiểm kê lại bắt buộc chọn lô có sẵn.`);
  }
}

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
  auditType: string,
  rawItems: unknown,
  existing: Array<{ variantId: string; lotItemId: string | null }> = [],
): Promise<NormalizedRow[]> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, "Cần ít nhất một dòng kiểm kê (nhân viên + SKU).");
  }

  const rows: NormalizedRow[] = (rawItems as AuditItemInput[]).map((raw, index) => {
    const assignedToUserId = typeof raw?.assignedToUserId === "string" ? raw.assignedToUserId.trim() : "";
    const variantId = typeof raw?.variantId === "string" ? raw.variantId.trim() : "";
    const lotItemId =
      typeof raw?.lotItemId === "string" && raw.lotItemId.trim() ? raw.lotItemId.trim() : null;
    if (!assignedToUserId) {
      throw new HttpError(400, `Dòng ${index + 1}: chưa chọn nhân viên.`);
    }
    if (!variantId) {
      throw new HttpError(400, `Dòng ${index + 1}: chưa chọn SKU.`);
    }

    // The audit type fixes the lot kind of every row: new-lot audits take no existing lot item,
    // re-audits require one. Neither role can change that while counting.
    assertLotMatchesAuditType(auditType, lotItemId, `Dòng ${index + 1}: `);

    const lotMode: LotMode = lotItemId ? "EXISTING" : "NEW";
    return { assignedToUserId, variantId, lotItemId, lotMode };
  });

  await assertAssigneesAreStaff(db, businessId, rows.map((r) => r.assignedToUserId));

  const variantIds = [...new Set(rows.map((r) => r.variantId))];
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds }, businessId, isActive: true },
    select: { id: true },
  });
  if (variants.length !== variantIds.length) {
    throw new HttpError(404, "Có SKU không tồn tại hoặc không hoạt động.");
  }

  const lotItemIds = [...new Set(rows.map((r) => r.lotItemId).filter((id): id is string => !!id))];
  if (lotItemIds.length > 0) {
    const lotItems = await db.productLotItem.findMany({
      where: { id: { in: lotItemIds }, businessId },
      select: { id: true, variantId: true, status: true, lot: { select: { lotNumber: true } } },
    });
    const itemVariant = new Map(lotItems.map((l) => [l.id, l.variantId]));
    const lotNumberById = new Map(lotItems.map((l) => [l.id, l.lot.lotNumber]));
    for (const row of rows) {
      if (row.lotItemId && itemVariant.get(row.lotItemId) !== row.variantId) {
        throw new HttpError(400, "Lô không tồn tại hoặc không thuộc SKU đã chọn.");
      }
    }

    // A lot that was already scrapped has no stock left to count, so it never enters an audit.
    const scrapped = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        if (!row.lotItemId) return false;
        const item = lotItems.find((l) => l.id === row.lotItemId);
        return item?.status === "SCRAPPED";
      })
      .map(
        ({ row, index }) =>
          `Dòng ${index + 1}: lô ${lotNumberById.get(row.lotItemId!) ?? row.lotItemId} đã bị hủy hàng.`,
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
        .filter(({ row }) => row.lotItemId && blocked.has(row.lotItemId))
        .map(({ row, index }) => {
          const order = blocked.get(row.lotItemId!)!;
          return `Dòng ${index + 1}: lô ${lotNumberById.get(row.lotItemId!) ?? row.lotItemId} có phiếu hủy ${order.scrapCode} (${scrapStatusLabel(order.status)}).`;
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
    if (!row.lotItemId) continue;
    const key = `${row.variantId}:${row.lotItemId}`;
    if (seen.has(key)) {
      throw new HttpError(409, "Có dòng kiểm kê trùng SKU và lô.");
    }
    seen.add(key);
  }

  return rows;
}

/** Build the data for new audit item rows: lot number autofilled, snapshot read from the balance. */
async function buildItemData(
  db: DbClient,
  businessId: string,
  auditId: string,
  createdBy: string,
  rows: NormalizedRow[],
) {
  const lotItemIds = [...new Set(rows.map((r) => r.lotItemId).filter((id): id is string => !!id))];
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
      lotNumber: row.lotItemId ? (lotNumberById.get(row.lotItemId) ?? null) : null,
      lotMode: row.lotMode,
      snapshotQty: row.lotItemId ? await getSnapshotQty(db, businessId, row.variantId, row.lotItemId) : 0,
      countedQty: 0,
      itemStatus: "IN_PROGRESS",
      assignedToUserId: row.assignedToUserId,
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
    const auditType = typeof body.auditType === "string" ? body.auditType.toUpperCase() : "NEW_LOTS";

    if (!["NEW_LOTS", "RE_AUDIT"].includes(auditType)) {
      throw new HttpError(400, "Loại kiểm kê không hợp lệ (NEW_LOTS, RE_AUDIT).");
    }

    const auditCode = providedCode || (await nextAuditCode(businessId));

    // Check if audit code is unique per business
    const existing = await prisma.stockAudit.findFirst({
      where: { businessId, auditCode },
    });
    if (existing) {
      throw new HttpError(409, `Mã kiểm kê "${auditCode}" đã tồn tại trong cửa hàng này.`);
    }

    // Items are added in a separate step from the audit detail page, so they are optional here.
    // When rows are provided (employee + variant + optional lot), they are validated and created too.
    const hasRows = Array.isArray(body.items) && body.items.length > 0;
    const rows = hasRows
      ? await normalizeAndValidateRows(prisma, businessId, auditType, body.items)
      : [];
    const affectedVariantIds = [...new Set(rows.map((r) => r.variantId))];

    // Create audit, lock variants and create the owner-defined items in one transaction
    const audit = await prisma.$transaction(async (tx) => {
      const created = await tx.stockAudit.create({
        data: {
          businessId,
          auditCode,
          auditType,
          status: "IN_PROGRESS",
          isLockedForAudit: true,
          createdBy: user.id,
        },
        select: {
          id: true,
          auditCode: true,
          scopeType: true,
          auditType: true,
          status: true,
          isLockedForAudit: true,
          countStartAt: true,
        },
      });

      if (rows.length > 0) {
        // Lock all affected variants
        await tx.productVariant.updateMany({
          where: { id: { in: affectedVariantIds } },
          data: { isLockedForAudit: true, updatedAt: new Date() },
        });

        const itemData = await buildItemData(tx, businessId, created.id, user.id, rows);

        // For RE_AUDIT type, lock the affected lot items
        if (auditType === "RE_AUDIT") {
          const lotItemIds = rows.map((r) => r.lotItemId).filter((id): id is string => !!id);
          if (lotItemIds.length > 0) {
            await tx.productLotItem.updateMany({
              where: { id: { in: lotItemIds } },
              data: { isLockedForAudit: true },
            });
          }
        }

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
      itemCount: rows.length,
      affectedVariantCount: affectedVariantIds.length,
    };
  }

  async listAudits(businessId: string, params: AuditListQuery) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(params.pageSize) || 10));
    const status = String(params.status ?? "").trim().toUpperCase();

    const where: Prisma.StockAuditWhereInput = { businessId };
    if (["IN_PROGRESS", "DONE", "CANCELLED"].includes(status)) {
      where.status = status;
    }

    const [audits, total] = await Promise.all([
      prisma.stockAudit.findMany({
        where,
        include: {
          approvedByUser: { select: { fullName: true, email: true } },
          stockAuditItems: { select: { id: true } },
        },
        orderBy: [{ countStartAt: "desc" }, { auditCode: "desc" }],
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
        approvedBy: audit.approvedByUser?.fullName || audit.approvedByUser?.email || null,
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  async getAudit(businessId: string, auditId: string) {
    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      include: {
        approvedByUser: { select: { fullName: true, email: true } },
        createdByUser: { select: { id: true, fullName: true, email: true } },
        stockAuditItems: {
          select: AUDIT_ITEM_SELECT,
          orderBy: { id: "asc" },
        },
      },
    });

    if (!audit) {
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
      approvedBy: audit.approvedByUser?.fullName || audit.approvedByUser?.email || null,
      createdBy: person(audit.createdByUser),
      itemCount: audit.stockAuditItems.length,
      items: audit.stockAuditItems.map(formatAuditItem),
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
      select: { id: true, assignedToUserId: true },
    });
    const item = candidates.find((c) => c.assignedToUserId === user.id) ?? candidates[0];

    if (!item) {
      throw new HttpError(
        404,
        "Không có dòng kiểm kê cho SKU/lô này. Chủ cửa hàng cần tạo dòng và giao cho nhân viên trước.",
      );
    }

    await assertCanActOnItem(prisma, businessId, user.id, item.assignedToUserId);

    await prisma.stockAuditItem.update({
      where: { id: item.id },
      data: { countedQty },
    });

    return getFormattedItem(prisma, item.id);
  }

  /** Owner: add more employee + variant + optional lot rows to an in-progress audit. */
  async addAuditItems(businessId: string, authUserId: string, auditId: string, body: AssignItemsBody) {
    const user = await resolveUser(authUserId);

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      select: { id: true, status: true, auditType: true },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    if (audit.status !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể thêm dòng khi đợt kiểm kê đang IN_PROGRESS.");
    }

    const existing = await prisma.stockAuditItem.findMany({
      where: { auditId },
      select: { variantId: true, lotItemId: true },
    });
    const rows = await normalizeAndValidateRows(prisma, businessId, audit.auditType, body.items, existing);
    const variantIds = [...new Set(rows.map((r) => r.variantId))];

    await prisma.$transaction(async (tx) => {
      await tx.productVariant.updateMany({
        where: { id: { in: variantIds } },
        data: { isLockedForAudit: true, updatedAt: new Date() },
      });

      if (audit.auditType === "RE_AUDIT") {
        const lotItemIds = rows.map((r) => r.lotItemId).filter((id): id is string => !!id);
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

  /** Owner: reassign an item to a different employee. */
  async reassignAuditItem(
    businessId: string,
    auditId: string,
    itemId: string,
    body: ReassignItemBody,
  ) {
    const assignedToUserId =
      typeof body.assignedToUserId === "string" ? body.assignedToUserId.trim() : "";
    if (!assignedToUserId) {
      throw new HttpError(400, "Chưa chọn nhân viên.");
    }

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      select: { status: true },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    if (audit.status !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể đổi người được giao khi đợt kiểm kê đang IN_PROGRESS.");
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

    await assertAssigneesAreStaff(prisma, businessId, [assignedToUserId]);

    await prisma.stockAuditItem.update({
      where: { id: itemId },
      data: { assignedToUserId },
    });

    return getFormattedItem(prisma, itemId);
  }

  async updateCount(
    businessId: string,
    authUserId: string,
    auditId: string,
    itemId: string,
    body: UpdateCountBody,
  ) {
    const user = await resolveUser(authUserId);
    const countedQty = Math.trunc(Number(body.countedQty));
    const discrepancyReason =
      typeof body.discrepancyReason === "string" ? body.discrepancyReason.trim().slice(0, 1000) : null;

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
      throw new HttpError(409, "Chỉ có thể cập nhật số đếm khi đợt kiểm kê đang IN_PROGRESS.");
    }

    const item = await prisma.stockAuditItem.findFirst({
      where: { id: itemId, auditId },
      select: {
        id: true,
        variantId: true,
        lotItemId: true,
        lotNumber: true,
        lotMode: true,
        newLotExpirationDate: true,
        newLotManufacturingDate: true,
        snapshotQty: true,
        itemStatus: true,
        assignedToUserId: true,
      },
    });

    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }

    await assertCanActOnItem(prisma, businessId, user.id, item.assignedToUserId);

    if (item.itemStatus !== "IN_PROGRESS") {
      throw new HttpError(409, "Chỉ có thể sửa dòng đang IN_PROGRESS.");
    }

    // Resolve the lot for this item. Existing lot item => autofill from product_lot_items.
    // New lot => number and expiry typed by the employee; the lot and its item are created on apply.
    const lotData: {
      lotItemId?: string | null;
      lotNumber?: string | null;
      newLotExpirationDate?: Date | null;
      newLotManufacturingDate?: Date | null;
      lotMode?: LotMode;
    } = {};
    let snapshotQty = item.snapshotQty;

    const lotItemId =
      typeof body.lotItemId === "string" && body.lotItemId.trim() ? body.lotItemId.trim() : null;
    const newLotNumber =
      typeof body.newLotNumber === "string" ? body.newLotNumber.trim().slice(0, 100) : "";

    if (lotItemId && newLotNumber) {
      throw new HttpError(400, "Chỉ chọn lô có sẵn hoặc nhập lô mới, không dùng cả hai.");
    }

    // The audit type fixes the lot of the row. A new-lot audit may never point at an existing lot item, and a
    // re-audit keeps the lot the owner assigned: the employee can still count and correct its dates, but cannot
    // switch the lot or create a new one.
    if (audit.auditType === "NEW_LOTS" && lotItemId) {
      throw new HttpError(400, "Đợt kiểm kê lô mới không được chọn lô có sẵn.");
    }
    if (audit.auditType === "RE_AUDIT") {
      if (newLotNumber || (body.lotItemId !== undefined && lotItemId !== item.lotItemId)) {
        throw new HttpError(400, "Đợt kiểm kê lại không được đổi lô của dòng kiểm kê.");
      }
    }

    // Where the audit type allows a choice, the request decides between an existing lot and a new one.
    if (lotItemId) {
      const lotItem = await prisma.productLotItem.findFirst({
        where: { id: lotItemId, businessId, variantId: item.variantId },
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

      const duplicate = await prisma.stockAuditItem.findFirst({
        where: { auditId, variantId: item.variantId, lotItemId, id: { not: itemId } },
        select: { id: true },
      });
      if (duplicate) {
        throw new HttpError(409, "Đợt kiểm kê này đã có dòng cho SKU và lô này.");
      }

      // The employee may correct a wrong expiry / manufacturing date. Only differences from the lot item
      // are stored; the lot item itself is updated when the owner applies the audit.
      const correction = resolveLotDateCorrection(lotItem, body);

      lotData.lotItemId = lotItem.id;
      lotData.lotNumber = lotItem.lot.lotNumber;
      lotData.lotMode = "EXISTING";
      lotData.newLotExpirationDate = correction.expiration;
      lotData.newLotManufacturingDate = correction.manufacturing;
      snapshotQty = await getSnapshotQty(prisma, businessId, item.variantId, lotItem.id);
    } else if (!newLotNumber && body.lotItemId === null && item.lotItemId) {
      // The employee switched to "New lot" but has not typed the number yet: drop the previous existing lot.
      lotData.lotItemId = null;
      lotData.lotNumber = null;
      lotData.lotMode = "NEW";
      lotData.newLotExpirationDate = null;
      lotData.newLotManufacturingDate = null;
      snapshotQty = 0;
    } else if (!newLotNumber && item.lotItemId && hasLotDateFields(body)) {
      // Same existing lot, only the dates changed
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
    } else if (newLotNumber) {
      const expiration = parseDate(body.newLotExpirationDate);
      if (!expiration) {
        throw new HttpError(400, "Lô mới cần có hạn sử dụng.");
      }
      const manufacturing = parseDate(body.newLotManufacturingDate);
      if (manufacturing && manufacturing > expiration) {
        throw new HttpError(400, "Ngày sản xuất không được sau hạn sử dụng.");
      }

      // A lot number is shared by every variant in the batch, so the number being taken only blocks
      // this row when the same variant is already inside that batch.
      const existingLot = await prisma.productLot.findFirst({
        where: { businessId, lotNumber: newLotNumber },
        select: { id: true, items: { where: { variantId: item.variantId }, select: { id: true } } },
      });
      if (existingLot && existingLot.items.length > 0) {
        throw new HttpError(
          409,
          `Lô "${newLotNumber}" đã có SKU này. Hãy chọn lô có sẵn trong danh sách.`,
        );
      }

      const sameNewLot = await prisma.stockAuditItem.findFirst({
        where: {
          auditId,
          variantId: item.variantId,
          lotItemId: null,
          lotNumber: newLotNumber,
          id: { not: itemId },
        },
        select: { id: true },
      });
      if (sameNewLot) {
        throw new HttpError(409, `Đợt kiểm kê này đã có lô mới "${newLotNumber}" cho SKU này.`);
      }

      lotData.lotItemId = null;
      lotData.lotNumber = newLotNumber;
      lotData.lotMode = "NEW";
      lotData.newLotExpirationDate = expiration;
      lotData.newLotManufacturingDate = manufacturing;
      snapshotQty = 0;
    }

    // Every counted row requires a discrepancy reason, whether or not quantities differ
    if (!discrepancyReason) {
      throw new HttpError(400, "Bắt buộc nhập lý do chênh lệch.");
    }

    await prisma.stockAuditItem.update({
      where: { id: itemId },
      data: {
        ...lotData,
        snapshotQty,
        countedQty,
        discrepancyReason: discrepancyReason || null,
      },
    });

    return getFormattedItem(prisma, itemId);
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
        submittedAt: true,
        submittedBy: true,
        approvedAt: true,
        approvedBy: true,
      },
    });

    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }

    // Only the assigned employee or the owner (on behalf) may submit
    await assertCanActOnItem(prisma, businessId, user.id, item.assignedToUserId);

    // Every item must have a lot number; a new lot also needs an expiration date
    if (!item.lotNumber) {
      throw new HttpError(400, "Cần chọn lô có sẵn hoặc nhập số lô trước khi nộp.");
    }
    if (!item.lotItemId && !item.newLotExpirationDate) {
      throw new HttpError(400, "Lô mới cần có hạn sử dụng trước khi nộp.");
    }

    // Every item requires a discrepancy reason before it can be submitted
    if (!item.discrepancyReason) {
      throw new HttpError(400, "Bắt buộc nhập lý do chênh lệch trước khi nộp.");
    }

    // Validate item is in IN_PROGRESS state
    if (item.itemStatus !== "IN_PROGRESS") {
      throw new HttpError(409, "Dòng kiểm kê không còn ở trạng thái IN_PROGRESS.");
    }

    await prisma.stockAuditItem.update({
      where: { id: itemId },
      data: {
        itemStatus: "PENDING_APPROVAL",
        submittedAt: new Date(),
        submittedBy: user.id,
        // A new submission answers any earlier rejection
        rejectionReason: null,
        rejectedAt: null,
        rejectedBy: null,
      },
    });

    return getFormattedItem(prisma, itemId);
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

    return getFormattedItem(prisma, itemId);
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
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    // The count page asks for "mine": only items assigned to the caller.
    let where: Prisma.StockAuditItemWhereInput = { auditId };
    if (params.mine) {
      const user = await resolveUser(authUserId);
      where = { auditId, assignedToUserId: user.id };
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
      items: items.map(formatAuditItem),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  /** Read one item of an audit. Used by the per-item count page. */
  async getAuditItem(businessId: string, auditId: string, itemId: string) {
    const item = await prisma.stockAuditItem.findFirst({
      where: { id: itemId, auditId, audit: { businessId } },
      select: AUDIT_ITEM_SELECT,
    });

    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }

    return formatAuditItem(item);
  }

  async approveAudit(businessId: string, authUserId: string, auditId: string) {
    const user = await resolveUser(authUserId);

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      include: {
        stockAuditItems: {
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

    // Validate: all items must be APPROVED (or we can allow PENDING_APPROVAL for backward compatibility)
    const nonApprovedItems = audit.stockAuditItems.filter(
      (item) => item.itemStatus !== "APPROVED" && item.itemStatus !== "PENDING_APPROVAL",
    );

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

    const updated = await prisma.stockAudit.update({
      where: { id: auditId },
      data: {
        status: "DONE",
        approvedBy: user.id,
        completedAt: new Date(),
      },
      select: {
        id: true,
        auditCode: true,
        status: true,
        approvedBy: true,
      },
    });

    return {
      id: updated.id,
      auditCode: updated.auditCode,
      status: updated.status,
      approvedBy: user.fullName || user.email,
    };
  }

  async applyAudit(businessId: string, authUserId: string, auditId: string) {
    const user = await resolveUser(authUserId);
    const lotStatusService = new LotStatusService();

    return prisma.$transaction(async (tx) => {
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
              diffQty: true,
              discrepancyReason: true,
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

      // Check auditType to determine business logic
      if (!audit.auditType) {
        throw new HttpError(400, "Loại kiểm kê không xác định.");
      }

      if (audit.stockAuditItems.length === 0) {
        throw new HttpError(400, "Đợt kiểm kê chưa có dòng kiểm kê nào để áp dụng.");
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
        // The lot item this row is applied to. Starts as the existing item (if any).
        let lotItemId: string | null = item.lotItemId;

        // Step 1: Resolve the batch header and its item, creating both when the employee typed a new lot.
        if (!lotItemId && item.lotNumber) {
          // New lot typed by the employee: the batch header is created only if the number is new,
          // so two variants entered with the same number end up in one batch.
          if (!item.newLotExpirationDate) {
            throw new HttpError(400, `Lô mới "${item.lotNumber}" thiếu hạn sử dụng.`);
          }

          const lot = await tx.productLot.upsert({
            where: { businessId_lotNumber: { businessId, lotNumber: item.lotNumber } },
            create: { businessId, lotNumber: item.lotNumber },
            update: {},
            select: { id: true },
          });

          const clash = await tx.productLotItem.findFirst({
            where: { lotId: lot.id, variantId: item.variantId },
            select: { id: true },
          });
          if (clash) {
            throw new HttpError(
              409,
              `Lô "${item.lotNumber}" đã có SKU này ở nơi khác trong lúc kiểm kê. Hãy đổi dòng này sang lô có sẵn.`,
            );
          }

          const createdItem = await tx.productLotItem.create({
            data: {
              businessId,
              lotId: lot.id,
              variantId: item.variantId,
              manufacturingDate: item.newLotManufacturingDate,
              expirationDate: item.newLotExpirationDate,
              status: lotStatusService.calculateStatus(item.newLotExpirationDate),
              isLockedForAudit: false,
            },
            select: { id: true },
          });

          lotItemId = createdItem.id;
          await tx.stockAuditItem.update({
            where: { id: item.id },
            data: { lotItemId },
          });
        } else if (item.lotItem) {
          // Existing lot item. The employee may have corrected its expiry / manufacturing date during the count.
          const correctedExpiration = item.newLotExpirationDate;
          const correctedManufacturing = item.newLotManufacturingDate;
          const hasCorrection = Boolean(correctedExpiration || correctedManufacturing);

          if (hasCorrection || audit.auditType === "RE_AUDIT") {
            const expirationDate = correctedExpiration ?? item.lotItem.expirationDate;
            const recalculatedStatus = lotStatusService.calculateStatus(expirationDate);
            const wasQuarantined = item.lotItem.status === "QUARANTINED";
            const wasScrapped = item.lotItem.status === "SCRAPPED";
            // A re-audit releases a quarantine only when the lot is sellable again. Expiry alone never
            // releases a quarantine, and a scrap decision is never undone.
            const releasesQuarantine =
              audit.auditType === "RE_AUDIT" &&
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
                ...(audit.auditType === "RE_AUDIT" ? { isLockedForAudit: false } : {}),
              },
            });
          }
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
              damagedQuantity: 0,
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

      // Unlock all affected variants
      await tx.productVariant.updateMany({
        where: { id: { in: affectedVariantIds } },
        data: { isLockedForAudit: false, updatedAt: new Date() },
      });

      // Mark audit as DONE
      const applied = await tx.stockAudit.update({
        where: { id: auditId },
        data: {
          status: "DONE",
          completedAt: new Date(),
          isLockedForAudit: false,
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
