import { Prisma, StockTransactionType } from "@prisma/client";

import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../../shared/http/http-error";

const num = (value: unknown) => Number(value ?? 0);

type CreateAuditBody = {
  auditCode?: unknown;
  scopeType?: unknown;
  scopeValue?: unknown;
  note?: unknown;
};

type RecordCountBody = {
  variantId?: unknown;
  lotId?: unknown;
  countedQty?: unknown;
};

type UpdateCountBody = {
  countedQty?: unknown;
  discrepancyReason?: unknown;
};

type AuditListQuery = {
  status?: string;
  page?: number;
  pageSize?: number;
};

type AuditItemsQuery = {
  page?: number;
  pageSize?: number;
};

async function resolveUser(authUserId: string) {
  const user = await prisma.user.findUnique({ where: { authUserId } });
  if (!user || !user.isActive) {
    throw new HttpError(403, "Tài khoản chưa được đồng bộ với cửa hàng.");
  }
  return user;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

class AuditService {
  async createAudit(businessId: string, authUserId: string, body: CreateAuditBody) {
    const user = await resolveUser(authUserId);

    const auditCode = typeof body.auditCode === "string" ? body.auditCode.trim() : "";
    const scopeType = typeof body.scopeType === "string" ? body.scopeType.toUpperCase() : "FULL_STORE";
    const scopeValue = typeof body.scopeValue === "string" ? body.scopeValue.trim() : null;

    if (!auditCode) {
      throw new HttpError(400, "Mã kiểm kê không được trống.");
    }

    if (!["FULL_STORE", "CATEGORY", "SHELF"].includes(scopeType)) {
      throw new HttpError(400, "Loại phạm vi kiểm kê không hợp lệ (FULL_STORE, CATEGORY, SHELF).");
    }

    // Check if audit code is unique per business
    const existing = await prisma.stockAudit.findFirst({
      where: { businessId, auditCode },
    });
    if (existing) {
      throw new HttpError(409, `Mã kiểm kê "${auditCode}" đã tồn tại trong cửa hàng này.`);
    }

    // Validate scope_value based on scope_type
    let affectedVariantIds: string[] = [];
    if (scopeType === "FULL_STORE") {
      // Get all active variants in this business
      affectedVariantIds = (
        await prisma.productVariant.findMany({
          where: { businessId, isActive: true },
          select: { id: true },
        })
      ).map((v) => v.id);
    } else if (scopeType === "CATEGORY" && scopeValue) {
      // Get variants in this category (including subcategories)
      const category = await prisma.category.findFirst({
        where: { id: scopeValue, businessId },
        include: { children: { select: { id: true } } },
      });
      if (!category) {
        throw new HttpError(404, "Không tìm thấy danh mục.");
      }
      const categoryIds = [category.id, ...category.children.map((c) => c.id)];
      affectedVariantIds = (
        await prisma.productVariant.findMany({
          where: {
            businessId,
            isActive: true,
            template: { categoryId: { in: categoryIds } },
          },
          select: { id: true },
        })
      ).map((v) => v.id);
    } else if (scopeType === "SHELF" && scopeValue) {
      // Get variants on this shelf (assuming shelf_id is stored somewhere)
      // For MVP, treat SHELF as a variant ID selector (placeholder)
      affectedVariantIds = [scopeValue];
    }

    if (affectedVariantIds.length === 0) {
      throw new HttpError(400, "Phạm vi kiểm kê không chứa SKU nào.");
    }

    // Create audit and lock variants in transaction
    const audit = await prisma.$transaction(async (tx) => {
      const created = await tx.stockAudit.create({
        data: {
          businessId,
          auditCode,
          scopeType,
          status: "IN_PROGRESS",
          isLockedForAudit: true,
        },
      });

      // Lock all affected variants
      await tx.productVariant.updateMany({
        where: { id: { in: affectedVariantIds } },
        data: { isLockedForAudit: true, updatedAt: new Date() },
      });

      return created;
    }, { timeout: 30000 });

    return {
      id: audit.id,
      auditCode: audit.auditCode,
      scopeType: audit.scopeType,
      status: audit.status,
      isLockedForAudit: audit.isLockedForAudit,
      countStartAt: audit.countStartAt,
      affectedVariantCount: affectedVariantIds.length,
    };
  }

  async listAudits(businessId: string, params: AuditListQuery) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(params.pageSize) || 10));
    const status = String(params.status ?? "").trim().toUpperCase();

    const where: Prisma.StockAuditWhereInput = { businessId };
    if (["IN_PROGRESS", "PENDING_APPROVAL", "APPLIED", "CANCELLED"].includes(status)) {
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
        stockAuditItems: {
          select: {
            id: true,
            variantId: true,
            lotId: true,
            snapshotQty: true,
            countedQty: true,
            diffQty: true,
            discrepancyReason: true,
          },
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
      status: audit.status,
      isLockedForAudit: audit.isLockedForAudit,
      countStartAt: audit.countStartAt,
      completedAt: audit.completedAt,
      approvedBy: audit.approvedByUser?.fullName || audit.approvedByUser?.email || null,
      itemCount: audit.stockAuditItems.length,
      items: audit.stockAuditItems,
    };
  }

  async recordCount(businessId: string, auditId: string, body: RecordCountBody) {
    const variantId = typeof body.variantId === "string" ? body.variantId.trim() : "";
    const lotId = typeof body.lotId === "string" ? body.lotId.trim() : null;
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

    // Verify variant exists and belongs to business
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, businessId, isActive: true },
    });

    if (!variant) {
      throw new HttpError(404, "SKU không tồn tại hoặc không hoạt động.");
    }

    return prisma.$transaction(async (tx) => {
      // Check if item already exists
      let item = await tx.stockAuditItem.findFirst({
        where: { auditId, variantId, lotId },
      });

      if (item) {
        // Update existing item
        const updated = await tx.stockAuditItem.update({
          where: { id: item.id },
          data: { countedQty },
        });
        return { id: updated.id, created: false, snapshotQty: updated.snapshotQty, countedQty: updated.countedQty };
      }

      // Create new item - capture snapshot from current inventory_balances
      const balance = await tx.inventoryBalance.findFirst({
        where: { businessId, variantId, lotId },
      });

      const snapshotQty = balance?.quantityOnHand ?? 0;

      const created = await tx.stockAuditItem.create({
        data: {
          auditId,
          variantId,
          lotId,
          snapshotQty,
          countedQty,
        },
      });

      return { id: created.id, created: true, snapshotQty, countedQty };
    }, { timeout: 30000 });
  }

  async updateCount(
    businessId: string,
    auditId: string,
    itemId: string,
    body: UpdateCountBody,
  ) {
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
    });

    if (!item) {
      throw new HttpError(404, "Không tìm thấy dòng kiểm kê.");
    }

    // Validate discrepancy reason if diff != 0
    const diffQty = countedQty - item.snapshotQty;
    if (diffQty !== 0 && !discrepancyReason) {
      throw new HttpError(400, "Khi có chênh lệch, bắt buộc phải nhập lý do.");
    }

    const updated = await prisma.stockAuditItem.update({
      where: { id: itemId },
      data: {
        countedQty,
        discrepancyReason: discrepancyReason || null,
      },
    });

    return {
      id: updated.id,
      snapshotQty: updated.snapshotQty,
      countedQty: updated.countedQty,
      diffQty: updated.diffQty,
      discrepancyReason: updated.discrepancyReason,
    };
  }

  async getAuditItems(businessId: string, auditId: string, params: AuditItemsQuery) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 20));

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
    });

    if (!audit) {
      throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
    }

    const [items, total] = await Promise.all([
      prisma.stockAuditItem.findMany({
        where: { auditId },
        include: {
          variant: {
            include: {
              template: { select: { name: true, imageUrl: true } },
              variantAttributeValues: {
                include: {
                  attribute: { select: { name: true } },
                  attributeValue: { select: { value: true } },
                },
              },
            },
          },
          lot: {
            select: {
              id: true,
              lotNumber: true,
              expirationDate: true,
            },
          },
        },
        orderBy: { id: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.stockAuditItem.count({ where: { auditId } }),
    ]);

    return {
      items: items.map((item) => ({
        id: item.id,
        variantId: item.variantId,
        sku: item.variant.sku,
        productName: item.variant.template.name,
        imageUrl: item.variant.template.imageUrl,
        attributeText: item.variant.variantAttributeValues
          .map((v) => v.attributeValue.value)
          .join(" · "),
        lotId: item.lot?.id ?? null,
        lotNumber: item.lot?.lotNumber ?? null,
        expirationDate: item.lot?.expirationDate ?? null,
        snapshotQty: item.snapshotQty,
        countedQty: item.countedQty,
        diffQty: item.diffQty,
        discrepancyReason: item.discrepancyReason,
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  async approveAudit(businessId: string, authUserId: string, auditId: string) {
    const user = await resolveUser(authUserId);

    const audit = await prisma.stockAudit.findFirst({
      where: { id: auditId, businessId },
      include: { stockAuditItems: true },
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

    // Validate: all items with diff != 0 must have discrepancy_reason
    for (const item of audit.stockAuditItems) {
      const diffQty = item.countedQty - item.snapshotQty;
      if (diffQty !== 0 && !item.discrepancyReason) {
        throw new HttpError(
          400,
          `Dòng kiểm kê ${item.id} có chênh lệch nhưng chưa có lý do. Bắt buộc nhập lý do trước khi phê duyệt.`,
        );
      }
    }

    const updated = await prisma.stockAudit.update({
      where: { id: auditId },
      data: {
        status: "PENDING_APPROVAL",
        approvedBy: user.id,
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

    return prisma.$transaction(async (tx) => {
      const audit = await tx.stockAudit.findFirst({
        where: { id: auditId, businessId },
        include: {
          stockAuditItems: {
            include: {
              variant: { select: { costPrice: true } },
            },
          },
        },
      });

      if (!audit) {
        throw new HttpError(404, "Không tìm thấy đợt kiểm kê.");
      }

      if (audit.status === "APPLIED") {
        // Idempotent - already applied
        return { id: audit.id, auditCode: audit.auditCode, status: audit.status };
      }

      if (audit.status !== "PENDING_APPROVAL") {
        throw new HttpError(409, "Chỉ có thể áp dụng đợt kiểm kê đang PENDING_APPROVAL.");
      }

      // Get all affected variants for unlocking
      const affectedVariantIds = audit.stockAuditItems.map((item) => item.variantId);

      // Apply each audit item
      const ledgerEntries = [];
      for (const item of audit.stockAuditItems) {
        // Update or create inventory_balance
        const balance = await tx.inventoryBalance.findFirst({
          where: {
            businessId,
            variantId: item.variantId,
            lotId: item.lotId,
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
              lotId: item.lotId,
              quantityOnHand: item.countedQty,
              damagedQuantity: 0,
            },
          });
        }

        // Create ledger entry if diff != 0
        const diffQty = item.countedQty - item.snapshotQty;
        if (diffQty !== 0) {
          const transactionType = diffQty > 0 ? "STOCK_ADJUSTMENT_IN" : "STOCK_ADJUSTMENT_OUT";
          const costPrice = item.variant.costPrice;

          const totalBalance = await tx.inventoryBalance.aggregate({
            where: { businessId, variantId: item.variantId },
            _sum: { quantityOnHand: true },
          });

          ledgerEntries.push({
            businessId,
            variantId: item.variantId,
            lotId: item.lotId,
            transactionType: transactionType as StockTransactionType,
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

      // Mark audit as applied
      const applied = await tx.stockAudit.update({
        where: { id: auditId },
        data: {
          status: "APPLIED",
          completedAt: new Date(),
          isLockedForAudit: false,
        },
      });

      return {
        id: applied.id,
        auditCode: applied.auditCode,
        status: applied.status,
        itemsApplied: audit.stockAuditItems.length,
        ledgerEntriesCreated: ledgerEntries.length,
      };
    }, { timeout: 60000 });
  }
}

export const auditService = new AuditService();
