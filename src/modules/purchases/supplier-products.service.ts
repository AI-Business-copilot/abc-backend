import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";
import { money, object } from "./purchases.input";
import { filters, pagination, uuid, type PurchaseQuery } from "./purchases.query";

function handleSchemaError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021" && error.message.includes("supplier_products")) {
    throw new HttpError(503, "Chức năng sản phẩm nhà cung cấp chưa được kích hoạt.");
  }
  throw error;
}

export class SupplierProductsService {
  async list(businessId: string, id: string, query: PurchaseQuery) {
    const supplierId = uuid(id, "supplierId");
    const f = filters(query, []);
    if (query.kind !== undefined && query.kind !== "catalog" && query.kind !== "history") throw new HttpError(400, "Invalid product list kind.");
    return prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({ where: { id: supplierId, businessId } });
      if (!supplier) throw new HttpError(404, "Supplier not found.");
      const receiptWhere = { businessId, supplierId, status: "RECEIVED" as const };
      const where: Prisma.ProductVariantWhereInput = {
        businessId,
        ...(query.kind === "history"
          ? { purchaseReceiptItems: { some: { receipt: receiptWhere } } }
          : { supplierProducts: { some: { businessId, supplierId } } }),
        ...(f.search ? { OR: [
          { sku: { contains: f.search, mode: "insensitive" } },
          { barcode: { contains: f.search, mode: "insensitive" } },
          { template: { name: { contains: f.search, mode: "insensitive" } } },
        ] } : {}),
      };
      const rows = await tx.productVariant.findMany({
        where, skip: f.skip, take: f.pageSize, orderBy: [{ sku: "asc" }, { id: "asc" }],
        include: {
          template: { select: { name: true, hasLotTracking: true } },
          inventoryBalances: { where: { businessId }, select: { quantityOnHand: true } },
          supplierProducts: { where: { businessId, supplierId } },
          purchaseReceiptItems: {
            where: { receipt: receiptWhere },
            orderBy: [{ receipt: { receivedAt: "desc" } }, { receiptId: "desc" }, { id: "desc" }], take: 1,
            select: { actualCost: true, receivedQty: true, receipt: { select: { id: true, receiptCode: true, receivedAt: true } } },
          },
        },
      });
      const total = await tx.productVariant.count({ where });
      return {
        supplier, pagination: pagination(f.page, f.pageSize, total),
        items: rows.map((row) => ({
          id: row.id, sku: row.sku, productName: row.template.name,
          hasLotTracking: Boolean(row.template.hasLotTracking), isActive: row.isActive === true,
          costPrice: Number(row.costPrice ?? 0),
          onHand: row.inventoryBalances.reduce((sum, balance) => sum + balance.quantityOnHand, 0),
          supplyPrice: row.supplierProducts[0]?.supplyPrice.toFixed(2) ?? null,
          lastPurchase: row.purchaseReceiptItems[0] ? {
            ...row.purchaseReceiptItems[0].receipt,
            actualCost: row.purchaseReceiptItems[0].actualCost.toFixed(2), receivedQty: row.purchaseReceiptItems[0].receivedQty,
          } : null,
        })),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }).catch(handleSchemaError);
  }

  async save(businessId: string, id: string, value: unknown) {
    const supplierId = uuid(id, "supplierId");
    const body = object(value);
    const variantId = uuid(body.variantId, "variantId");
    const supplyPrice = money(body.supplyPrice, "supplyPrice");
    return prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({ where: { id: supplierId, businessId } });
      if (!supplier) throw new HttpError(404, "Supplier not found.");
      const variant = await tx.productVariant.findFirst({ where: { id: variantId, businessId, isActive: true } });
      if (!variant) throw new HttpError(404, "Active SKU not found.");
      return tx.supplierProduct.upsert({
        where: { businessId_supplierId_variantId: { businessId, supplierId, variantId } },
        create: { businessId, supplierId, variantId, supplyPrice }, update: { supplyPrice },
      });
    }).catch(handleSchemaError);
  }

  async remove(businessId: string, id: string, variant: string) {
    const supplierId = uuid(id, "supplierId"); const variantId = uuid(variant, "variantId");
    const result = await prisma.supplierProduct.deleteMany({ where: { businessId, supplierId, variantId } }).catch(handleSchemaError);
    if (!result.count) throw new HttpError(404, "Supplier product not found.");
    return { removed: true };
  }
}

export const supplierProductsService = new SupplierProductsService();
