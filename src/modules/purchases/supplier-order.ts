import { Prisma } from "@prisma/client";
import { HttpError } from "../../shared/http/http-error";
import { supplierInBusiness } from "./purchases-transaction";

export async function validateSupplierOrder(tx: Prisma.TransactionClient, businessId: string, supplierId: string, lines: { variantId: string; orderedQty: number }[]) {
  const supplier = await supplierInBusiness(tx, businessId, supplierId);
  if (!supplier.isActive) throw new HttpError(409, "NCC đã ngừng hợp tác, không thể đặt mua mới.");
  if (!lines.length) return;
  const catalog = await tx.supplierProduct.findMany({ where: { businessId, supplierId, isActive: true, variantId: { in: lines.map(line => line.variantId) } } });
  for (const line of lines) {
    const product = catalog.find(row => row.variantId === line.variantId);
    if (!product) throw new HttpError(400, "SKU chưa thuộc danh mục đang cung cấp của NCC. Vui lòng khai báo trước khi đặt mua.");
    if (line.orderedQty < product.minOrderQty || line.orderedQty % product.orderMultiple !== 0) throw new HttpError(400, `Số lượng đặt phải tối thiểu ${product.minOrderQty} và là bội số của ${product.orderMultiple}.`);
  }
}
