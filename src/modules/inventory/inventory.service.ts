import { Prisma, StockTransactionType } from "@prisma/client";

import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";

const num = (value: unknown) => Number(value ?? 0);
const likeTerm = (value: string) => `%${value.replace(/[%_]/g, "")}%`;

type OpeningItemInput = {
  variantId?: unknown;
  quantity?: unknown;
  unitCost?: unknown;
  lotNumber?: unknown;
  manufacturingDate?: unknown;
  expirationDate?: unknown;
};

type OpeningSheetBody = {
  note?: unknown;
  items?: unknown;
  apply?: unknown;
};

type LedgerQuery = {
  search?: string;
  type?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

const LEDGER_LABELS: Record<string, string> = {
  OPENING_STOCK: "Tồn đầu kỳ",
  PURCHASE_RECEIPT: "Nhập mua PO",
  POS_SALE: "Bán POS",
  CUSTOMER_RETURN: "Khách trả hàng",
  VENDOR_RETURN: "Trả nhà cung cấp",
  STOCK_ADJUSTMENT_IN: "Cân chỉnh tăng",
  STOCK_ADJUSTMENT_OUT: "Cân chỉnh giảm",
  SCRAP_DISPOSAL: "Hủy hàng",
};

const STOCK_TYPES = new Set(Object.keys(LEDGER_LABELS));

function monthRange(month: string): { gte: Date; lt: Date } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return {
    gte: new Date(Date.UTC(year, monthIndex, 1)),
    lt: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDay(value: unknown): Date | null {
  const date = parseDate(value);
  if (!date) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isLotTracking(template: { hasLotTracking: boolean | null } | null | undefined): boolean {
  return Boolean(template?.hasLotTracking);
}

async function resolveUser(authUserId: string) {
  const user = await prisma.user.findUnique({ where: { authUserId } });
  if (!user || !user.isActive) {
    throw new HttpError(403, "Tài khoản chưa được đồng bộ với cửa hàng.");
  }
  return user;
}

function normalizeItems(body: OpeningSheetBody) {
  const raw = Array.isArray(body.items) ? (body.items as OpeningItemInput[]) : [];
  if (raw.length === 0) {
    throw new HttpError(400, "Phiếu nạp tồn cần ít nhất một dòng SKU.");
  }
  if (raw.length > 500) {
    throw new HttpError(400, "Mỗi phiếu nạp tồn chỉ hỗ trợ tối đa 500 dòng SKU.");
  }

  return raw.map((item, index) => {
    const variantId = typeof item.variantId === "string" ? item.variantId.trim() : "";
    const quantity = Math.trunc(Number(item.quantity));
    const unitCost = Number(item.unitCost);

    if (!variantId) {
      throw new HttpError(400, `Dòng ${index + 1}: thiếu SKU.`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new HttpError(400, `Dòng ${index + 1}: số lượng nạp phải lớn hơn 0.`);
    }
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new HttpError(400, `Dòng ${index + 1}: giá vốn không hợp lệ.`);
    }

    return {
      variantId,
      quantity,
      unitCost: Math.round(unitCost * 100) / 100,
      lotNumber: typeof item.lotNumber === "string" ? item.lotNumber.trim() : "",
      manufacturingDate: parseDay(item.manufacturingDate),
      expirationDate: parseDay(item.expirationDate),
    };
  });
}

type NormalizedItem = ReturnType<typeof normalizeItems>[number];

function assertNoDuplicates(items: NormalizedItem[]) {
  const noLot = new Set<string>();
  const withLot = new Set<string>();
  for (const item of items) {
    const key = `${item.variantId}|${item.lotNumber.toLowerCase()}`;
    if (item.lotNumber) {
      if (withLot.has(key)) {
        throw new HttpError(400, "Một SKU chỉ được xuất hiện một lần cho mỗi số lô.");
      }
      withLot.add(key);
    } else {
      if (noLot.has(item.variantId)) {
        throw new HttpError(400, "Một SKU không quản lý lô chỉ được xuất hiện một lần trong phiếu.");
      }
      noLot.add(item.variantId);
    }
  }
}

async function nextSheetCode(businessId: string) {
  const year = new Date().getFullYear();
  const prefix = `OSTK-${year}-`;
  const last = await prisma.openingStockSheet.findFirst({
    where: { businessId, code: { startsWith: prefix } },
    orderBy: { code: "desc" },
    select: { code: true },
  });
  const sequence = last?.code ? Number(last.code.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(Number.isFinite(sequence) ? sequence : 1).padStart(3, "0")}`;
}

async function loadItemsForSheet(
  tx: Prisma.TransactionClient,
  businessId: string,
  sheetId: string,
  limit: number,
  offset: number,
) {
  return tx.openingStockItem.findMany({
    where: { sheetId },
    include: {
      variant: {
        include: {
          template: { select: { name: true, imageUrl: true, unitOfMeasure: true, hasLotTracking: true } },
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
          manufacturingDate: true,
          expirationDate: true,
        },
      },
    },
    orderBy: { id: "asc" },
    take: limit,
    skip: offset,
  }).then((items) =>
    Promise.all(
      items.map(async (item) => {
        const balance = await tx.inventoryBalance.aggregate({
          where: { businessId, variantId: item.variantId },
          _sum: { quantityOnHand: true },
        });
        return { item, onHand: balance._sum.quantityOnHand ?? 0 };
      }),
    ),
  );
}

async function writeItems(
  tx: Prisma.TransactionClient,
  businessId: string,
  sheetId: string,
  items: NormalizedItem[],
) {
  const variants = await tx.productVariant.findMany({
    where: { businessId, id: { in: items.map((item) => item.variantId) } },
    include: { template: { select: { hasLotTracking: true } } },
  });
  const variantMap = new Map(variants.map((variant) => [variant.id, variant]));

  for (const item of items) {
    const variant = variantMap.get(item.variantId);
    if (!variant) {
      throw new HttpError(404, "Có SKU không thuộc cửa hàng hiện tại.");
    }

    const tracksLot = isLotTracking(variant.template) || Boolean(item.lotNumber);
    let lotId: string | null = null;

    if (item.lotNumber && item.lotNumber.trim()) {
      const cleanLotNum = item.lotNumber.trim();
      const lot = await tx.productLot.upsert({
        where: {
          businessId_variantId_lotNumber: {
            businessId,
            variantId: variant.id,
            lotNumber: cleanLotNum,
          },
        },
        create: {
          businessId,
          variantId: variant.id,
          lotNumber: cleanLotNum,
          manufacturingDate: item.manufacturingDate ? new Date(item.manufacturingDate) : null,
          expirationDate: item.expirationDate ? new Date(item.expirationDate) : (new Date("2099-12-31")),
        },
        update: {
          manufacturingDate: item.manufacturingDate ? new Date(item.manufacturingDate) : undefined,
          expirationDate: item.expirationDate ? new Date(item.expirationDate) : undefined,
        },
      });
      lotId = lot.id;

      // Đồng bộ vào bảng product_lot_items trên Supabase để giữ toàn vẹn dữ liệu cho team dev
      try {
        await tx.$executeRaw`
          INSERT INTO product_lot_items (
            id, business_id, lot_id, variant_id, manufacturing_date, expiration_date, status
          )
          VALUES (
            gen_random_uuid(),
            ${businessId}::uuid, ${lot.id}::uuid, ${variant.id}::uuid,
            ${item.manufacturingDate ? new Date(item.manufacturingDate) : null},
            ${item.expirationDate ? new Date(item.expirationDate) : null},
            'ACTIVE'
          )
          ON CONFLICT (business_id, lot_id, variant_id) DO UPDATE
          SET manufacturing_date = EXCLUDED.manufacturing_date,
              expiration_date = EXCLUDED.expiration_date;
        `;
      } catch {
        // ignore if already present
      }
    }

    await tx.openingStockItem.create({
      data: {
        sheetId,
        variantId: variant.id,
        lotId,
        quantity: item.quantity,
        unitCost: new Prisma.Decimal(item.unitCost),
      },
    });
  }
}

async function cleanupOrphanLots(_tx: Prisma.TransactionClient, _lotIds: string[]) {
  // Giữ lại dữ liệu lô trong product_lots & product_lot_items khi lưu nháp
  // Không xóa lô để không làm mất dữ liệu của người dùng và đồng nghiệp
}

class InventoryService {
  private async sheetRows(businessId: string, sheetId: string, limit: number, offset: number) {
    const sheet = await prisma.openingStockSheet.findFirst({
      where: { id: sheetId, businessId },
      include: {
        createdByUser: { select: { fullName: true, email: true } },
      },
    });
    if (!sheet) throw new HttpError(404, "Không tìm thấy phiếu nạp tồn.");

    const [totals, pairItems, itemTotal] = await Promise.all([
      prisma.openingStockItem.aggregate({
        where: { sheetId },
        _count: { _all: true },
        _sum: { quantity: true },
      }),
      loadItemsForSheet(prisma, businessId, sheetId, limit, offset),
      prisma.openingStockItem.count({ where: { sheetId } }),
    ]);

    const totalValue = pairItems.reduce(
      (sum, pair) => sum + pair.item.quantity * num(pair.item.unitCost),
      0,
    );

    return {
      id: sheet.id,
      code: sheet.code,
      note: sheet.note,
      status: sheet.status,
      createdByName: sheet.createdByUser?.fullName || sheet.createdByUser?.email || "Người dùng",
      createdAt: sheet.createdAt,
      appliedAt: sheet.appliedAt,
      itemTotal,
      totals: {
        itemCount: totals._count._all,
        quantity: totals._sum.quantity ?? 0,
        value: Math.round(totalValue * 100) / 100,
      },
      items: pairItems.map(({ item, onHand }) => ({
        id: item.id,
        variantId: item.variantId,
        sku: item.variant.sku,
        barcode: item.variant.barcode,
        productName: item.variant.template.name,
        imageUrl: item.variant.template.imageUrl,
        unit: item.variant.template.unitOfMeasure || "cái",
        attributeText: item.variant.variantAttributeValues
          .map((value) => value.attributeValue.value)
          .join(" · "),
        lotId: item.lot?.id ?? null,
        lotNumber: item.lot?.lotNumber ?? null,
        manufacturingDate: item.lot?.manufacturingDate ?? null,
        expirationDate: item.lot?.expirationDate ?? null,
        quantity: item.quantity,
        unitCost: num(item.unitCost),
        lineTotal: num(item.unitCost) * item.quantity,
        onHand,
        stockStatus: sheet.status === "APPLIED" ? "recorded" : "pending",
      })),
    };
  }

  async listSheets(
    businessId: string,
    params: { search?: string; status?: string; month?: string; page?: number; pageSize?: number },
  ) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(params.pageSize) || 5));
    const search = String(params.search ?? "").trim();
    const status = String(params.status ?? "").trim().toUpperCase();
    const range = params.month ? monthRange(params.month) : null;

    const where: Prisma.OpeningStockSheetWhereInput = { businessId };
    if (status === "APPLIED" || status === "DRAFT") where.status = status;
    if (range) where.createdAt = { gte: range.gte, lt: range.lt };
    if (search) {
      where.OR = [
        { code: { contains: search, mode: "insensitive" } },
        { note: { contains: search, mode: "insensitive" } },
        { createdByUser: { fullName: { contains: search, mode: "insensitive" } } },
        { openingStockItems: { some: { variant: { sku: { contains: search, mode: "insensitive" } } } } },
      ];
    }

    const [rows, total, statusStats, loaded, totalSku, appliedValue] = await Promise.all([
      prisma.openingStockSheet.findMany({
        where,
        include: {
          createdByUser: { select: { fullName: true, email: true } },
          openingStockItems: { select: { quantity: true, unitCost: true } },
        },
        orderBy: [{ createdAt: "desc" }, { code: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.openingStockSheet.count({ where }),
      prisma.openingStockSheet.groupBy({
        by: ["status"],
        where: { businessId },
        _count: { _all: true },
      }),
      prisma.$queryRaw<{ count: number }[]>`
        select count(distinct i.variant_id)::int as count
          from opening_stock_items i
          join opening_stock_sheets s on s.id = i.sheet_id
         where s.business_id = ${businessId}::uuid and s.status = 'APPLIED'
      `,
      prisma.productVariant.count({ where: { businessId } }),
      prisma.$queryRaw<{ amount: string | number }[]>`
        select coalesce(sum(i.quantity * i.unit_cost), 0) as amount
          from opening_stock_items i
          join opening_stock_sheets s on s.id = i.sheet_id
         where s.business_id = ${businessId}::uuid and s.status = 'APPLIED'
      `,
    ]);

    const statusMap = new Map(statusStats.map((row) => [row.status, row._count._all]));

    return {
      stats: {
        totalSheets: (statusMap.get("APPLIED") ?? 0) + (statusMap.get("DRAFT") ?? 0),
        appliedSheets: statusMap.get("APPLIED") ?? 0,
        draftSheets: statusMap.get("DRAFT") ?? 0,
        loadedSkuCount: loaded[0]?.count ?? 0,
        totalSkuCount: totalSku,
        totalOpeningValue: num(appliedValue[0]?.amount),
      },
      items: rows.map((row) => ({
        id: row.id,
        code: row.code,
        note: row.note,
        status: row.status,
        createdByName: row.createdByUser?.fullName || row.createdByUser?.email || "Người dùng",
        createdAt: row.createdAt,
        appliedAt: row.appliedAt,
        itemCount: row.openingStockItems.length,
        totalQty: row.openingStockItems.reduce((sum, item) => sum + item.quantity, 0),
        totalValue: Math.round(
          row.openingStockItems.reduce((sum, item) => sum + item.quantity * num(item.unitCost), 0),
        ),
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  async getSheet(businessId: string, sheetId: string, limit: number, offset: number) {
    return this.sheetRows(businessId, sheetId, limit, offset);
  }

  async getNextCode(businessId: string) {
    return { code: await nextSheetCode(businessId) };
  }

  async createSheet(businessId: string, authUserId: string, body: OpeningSheetBody) {
    const user = await resolveUser(authUserId);
    const items = normalizeItems(body);
    assertNoDuplicates(items);
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;
    const apply = Boolean(body.apply);

    const code = await nextSheetCode(businessId);

    const sheet = await prisma.$transaction(async (tx) => {
      const created = await tx.openingStockSheet.create({
        data: {
          businessId,
          createdBy: user.id,
          code,
          note,
          status: "DRAFT",
        },
      });
      await writeItems(tx, businessId, created.id, items);
      if (apply) {
        await this.applyWithin(tx, businessId, user.id, created.id);
      }
      return created;
    }, { timeout: 60000 });

    return this.sheetRows(businessId, sheet.id, 500, 0);
  }

  async updateSheet(
    businessId: string,
    authUserId: string,
    sheetId: string,
    body: OpeningSheetBody,
  ) {
    const user = await resolveUser(authUserId);
    const items = normalizeItems(body);
    assertNoDuplicates(items);
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;

    await prisma.$transaction(async (tx) => {
      const sheet = await tx.openingStockSheet.findFirst({ where: { id: sheetId, businessId } });
      if (!sheet) throw new HttpError(404, "Không tìm thấy phiếu nạp tồn.");
      if (sheet.status !== "DRAFT") {
        throw new HttpError(409, "Chỉ có thể sửa phiếu đang ở trạng thái bản nháp.");
      }

      const oldItems = await tx.openingStockItem.findMany({
        where: { sheetId },
        select: { lotId: true },
      });
      await tx.openingStockItem.deleteMany({ where: { sheetId } });
      await writeItems(tx, businessId, sheetId, items);
      await tx.openingStockSheet.update({
        where: { id: sheetId },
        data: { note, updatedAt: new Date() },
      });
      await cleanupOrphanLots(
        tx,
        oldItems.map((item) => item.lotId).filter((id): id is string => Boolean(id)),
      );
    }, { timeout: 30000 });

    return this.sheetRows(businessId, sheetId, 500, 0);
  }

  async applySheet(businessId: string, authUserId: string, sheetId: string) {
    const user = await resolveUser(authUserId);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        select id from opening_stock_sheets
         where id = ${sheetId}::uuid and business_id = ${businessId}::uuid
         for update
      `;
      await this.applyWithin(tx, businessId, user.id, sheetId);
    }, { timeout: 60000 });
    return this.sheetRows(businessId, sheetId, 500, 0);
  }

  private async applyWithin(
    tx: Prisma.TransactionClient,
    businessId: string,
    userId: string,
    sheetId: string,
  ) {
    const sheet = await tx.openingStockSheet.findFirst({
      where: { id: sheetId, businessId },
      include: { openingStockItems: { include: { lot: true } } },
    });
    if (!sheet) throw new HttpError(404, "Không tìm thấy phiếu nạp tồn.");
    if (sheet.status === "APPLIED") return;
    if (sheet.status !== "DRAFT") {
      throw new HttpError(409, "Phiếu nạp tồn này không ở trạng thái có thể áp dụng.");
    }
    if (sheet.openingStockItems.length === 0) {
      throw new HttpError(400, "Phiếu nạp tồn chưa có dòng SKU nào.");
    }

    for (const item of sheet.openingStockItems) {
      let balance = await tx.inventoryBalance.findFirst({
        where: { businessId, variantId: item.variantId, lotId: item.lotId },
      });

      if (!balance) {
        balance = await tx.inventoryBalance.create({
          data: {
            businessId,
            variantId: item.variantId,
            lotId: item.lotId,
            quantityOnHand: 0,
            damagedQuantity: 0,
          },
        });
      }

      const updated = await tx.inventoryBalance.update({
        where: { id: balance.id },
        data: { quantityOnHand: { increment: item.quantity }, updatedAt: new Date() },
      });

      const total = await tx.inventoryBalance.aggregate({
        where: { businessId, variantId: item.variantId },
        _sum: { quantityOnHand: true },
      });

      await tx.inventoryLedger.create({
        data: {
          businessId,
          variantId: item.variantId,
          lotId: item.lotId,
          transactionType: StockTransactionType.OPENING_STOCK,
          quantityChanged: item.quantity,
          balanceAfter: total._sum.quantityOnHand ?? updated.quantityOnHand,
          unitCost: item.unitCost,
          totalCostValue: new Prisma.Decimal(num(item.unitCost) * item.quantity),
          referenceDocType: "OPENING_STOCK_SHEET",
          referenceDocId: sheet.id,
          createdBy: userId,
        },
      });
    }

    await tx.openingStockSheet.update({
      where: { id: sheet.id },
      data: { status: "APPLIED", appliedAt: new Date(), updatedAt: new Date() },
    });
  }

  async removeSheet(businessId: string, sheetId: string) {
    await prisma.$transaction(async (tx) => {
      const sheet = await tx.openingStockSheet.findFirst({ where: { id: sheetId, businessId } });
      if (!sheet) throw new HttpError(404, "Không tìm thấy phiếu nạp tồn.");
      if (sheet.status !== "DRAFT") {
        throw new HttpError(409, "Chỉ có thể xoá phiếu đang ở trạng thái bản nháp.");
      }
      const items = await tx.openingStockItem.findMany({
        where: { sheetId },
        select: { lotId: true },
      });
      await tx.openingStockItem.deleteMany({ where: { sheetId } });
      await tx.openingStockSheet.delete({ where: { id: sheetId } });
      await cleanupOrphanLots(
        tx,
        items.map((item) => item.lotId).filter((id): id is string => Boolean(id)),
      );
    }, { timeout: 30000 });
    return { id: sheetId };
  }

  async searchVariants(
    businessId: string,
    params: { search?: string; categoryId?: string; limit?: number },
  ) {
    const search = String(params.search ?? "").trim();
    const categoryId = String(params.categoryId ?? "").trim();
    const limit = Math.min(60, Math.max(1, Number(params.limit) || 20));

    let categoryIds: string[] = [];
    if (categoryId) {
      const category = await prisma.category.findFirst({
        where: { id: categoryId, businessId },
        include: { children: { select: { id: true } } },
      });
      if (!category) throw new HttpError(404, "Không tìm thấy danh mục.");
      categoryIds = [category.id, ...category.children.map((child) => child.id)];
    }

    const where: Prisma.ProductVariantWhereInput = {
      businessId,
      isActive: true,
      ...(categoryIds.length > 0 ? { template: { categoryId: { in: categoryIds } } } : {}),
      ...(search
        ? {
            OR: [
              { sku: { contains: search, mode: "insensitive" } },
              { barcode: { contains: search, mode: "insensitive" } },
              { template: { name: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const [rows, total, categories] = await Promise.all([
      prisma.productVariant.findMany({
        where,
        include: {
          template: {
            select: {
              name: true,
              imageUrl: true,
              unitOfMeasure: true,
              hasLotTracking: true,
              category: { select: { id: true, name: true } },
            },
          },
          variantAttributeValues: {
            include: {
              attribute: { select: { name: true } },
              attributeValue: { select: { value: true } },
            },
          },
          inventoryBalances: { select: { quantityOnHand: true } },
        },
        orderBy: { sku: "asc" },
        take: limit,
      }),
      prisma.productVariant.count({ where }),
      prisma.$queryRaw<{ id: string; name: string; count: number }[]>`
        select c.id, c.name, count(distinct v.id)::int as count
          from categories c
          left join categories child on child.parent_id = c.id
          left join product_templates t on t.category_id = c.id or t.category_id = child.id
          left join product_variants v on v.template_id = t.id
         where c.business_id = ${businessId}::uuid and c.parent_id is null
         group by c.id, c.name
         order by c.name
      `,
    ]);

    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        sku: row.sku,
        barcode: row.barcode,
        productName: row.template.name,
        imageUrl: row.template.imageUrl,
        unit: row.template.unitOfMeasure || "cái",
        hasLotTracking: Boolean(row.template.hasLotTracking),
        categoryId: row.template.category?.id ?? null,
        categoryName: row.template.category?.name ?? null,
        costPrice: num(row.costPrice),
        basePrice: num(row.basePrice),
        onHand: row.inventoryBalances.reduce((sum, balance) => sum + balance.quantityOnHand, 0),
        attributeText: row.variantAttributeValues
          .map((value) => value.attributeValue.value)
          .join(" · "),
      })),
      categories,
    };
  }

  async getLots(businessId: string, variantId: string) {
    const lots = await prisma.productLot.findMany({
      where: { businessId, variantId },
      include: { inventoryBalances: { select: { quantityOnHand: true } } },
      orderBy: { expirationDate: "asc" },
    });
    return {
      items: lots.map((lot) => ({
        id: lot.id,
        lotNumber: lot.lotNumber,
        manufacturingDate: lot.manufacturingDate,
        expirationDate: lot.expirationDate,
        onHand: lot.inventoryBalances.reduce((sum, balance) => sum + balance.quantityOnHand, 0),
      })),
    };
  }

  async ledger(businessId: string, params: LedgerQuery) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 20));
    const search = String(params.search ?? "").trim();
    const type = String(params.type ?? "").trim().toUpperCase();
    const from = parseDate(params.from);
    const to = parseDate(params.to);

    const filters: Prisma.Sql[] = [Prisma.sql`l.business_id = ${businessId}::uuid`];
    if (STOCK_TYPES.has(type)) {
      filters.push(Prisma.sql`l.transaction_type = ${type}::stock_transaction_type`);
    }
    if (search) {
      const term = likeTerm(search);
      filters.push(Prisma.sql`(
        v.sku ilike ${term}
        or t.name ilike ${term}
        or coalesce(s.code, '') ilike ${term}
        or coalesce(u.full_name, '') ilike ${term}
      )`);
    }
    if (from) filters.push(Prisma.sql`l.created_at >= ${from}`);
    if (to) filters.push(Prisma.sql`l.created_at < ${to}`);

    const whereSql = Prisma.join(filters, " and ");

    const [rows, stats] = await Promise.all([
      prisma.$queryRaw<
        {
          id: string;
          created_at: Date;
          transaction_type: string;
          quantity_changed: number;
          balance_after: number;
          unit_cost: string | number;
          total_cost_value: string | number;
          variant_id: string;
          sku: string;
          template_name: string;
          image_url: string | null;
          created_by_name: string | null;
          sheet_code: string | null;
          attribute_text: string | null;
        }[]
      >(Prisma.sql`
        select l.id,
               l.created_at,
               l.transaction_type::text as transaction_type,
               l.quantity_changed,
               l.balance_after,
               l.unit_cost,
               l.total_cost_value,
               v.id as variant_id,
               v.sku,
               t.name as template_name,
               t.image_url,
               u.full_name as created_by_name,
               s.code as sheet_code,
               (
                 select string_agg(av.value, ' · ' order by a.name)
                   from variant_attribute_values vav
                   join attribute_values av on av.id = vav.attribute_value_id
                   join attributes a on a.id = vav.attribute_id
                  where vav.variant_id = v.id
               ) as attribute_text
          from inventory_ledger l
          join product_variants v on v.id = l.variant_id
          join product_templates t on t.id = v.template_id
          left join users u on u.id = l.created_by
          left join opening_stock_sheets s
                 on s.id = l.reference_doc_id and l.reference_doc_type = 'OPENING_STOCK_SHEET'
         where ${whereSql}
         order by l.created_at desc, l.id desc
         limit ${pageSize} offset ${(page - 1) * pageSize}
      `),
      prisma.$queryRaw<
        {
          total: number;
          increase_count: number;
          decrease_count: number;
          increase_qty: number;
          decrease_qty: number;
        }[]
      >(Prisma.sql`
        select count(*)::int as total,
               count(*) filter (where l.quantity_changed > 0)::int as increase_count,
               count(*) filter (where l.quantity_changed < 0)::int as decrease_count,
               coalesce(sum(l.quantity_changed) filter (where l.quantity_changed > 0), 0)::int as increase_qty,
               coalesce(sum(-l.quantity_changed) filter (where l.quantity_changed < 0), 0)::int as decrease_qty
          from inventory_ledger l
          join product_variants v on v.id = l.variant_id
          join product_templates t on t.id = v.template_id
          left join users u on u.id = l.created_by
          left join opening_stock_sheets s
                 on s.id = l.reference_doc_id and l.reference_doc_type = 'OPENING_STOCK_SHEET'
         where ${whereSql}
      `),
    ]);

    const summary = stats[0] ?? {
      total: 0,
      increase_count: 0,
      decrease_count: 0,
      increase_qty: 0,
      decrease_qty: 0,
    };

    return {
      stats: {
        totalEntries: summary.total,
        increaseCount: summary.increase_count,
        decreaseCount: summary.decrease_count,
        increaseQty: summary.increase_qty,
        decreaseQty: summary.decrease_qty,
      },
      items: rows.map((row) => {
        const reference = row.sheet_code
          ? row.sheet_code
          : `#${row.transaction_type.slice(0, 4)}-${row.id.slice(0, 8).toUpperCase()}`;
        return {
          id: row.id,
          createdAt: row.created_at,
          reference,
          sheetCode: row.sheet_code || reference,
          type: row.transaction_type,
          transactionType: row.transaction_type,
          typeLabel: LEDGER_LABELS[row.transaction_type] ?? row.transaction_type,
          quantityChanged: row.quantity_changed,
          balanceAfter: row.balance_after,
          unitCost: num(row.unit_cost),
          totalCostValue: num(row.total_cost_value),
          createdByName: row.created_by_name || "Hệ thống",
          variantId: row.variant_id,
          sku: row.sku,
          productName: row.template_name,
          imageUrl: row.image_url,
          attributeText: row.attribute_text ?? "",
        };
      }),
      pagination: {
        page,
        pageSize,
        total: summary.total,
        totalPages: Math.max(1, Math.ceil(summary.total / pageSize)),
      },
    };
  }
}

export const inventoryService = new InventoryService();
export { auditService } from "./services/audit.service";
export { auditLockService } from "./services/audit-lock.service";
