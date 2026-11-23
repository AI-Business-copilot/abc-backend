import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { HttpError } from "../../shared/http/http-error";
import { uuid } from "./purchases.query";
import { atomic } from "./purchases-transaction";
import { parseSupplierFile } from "./supplier-import.parser";

type File = { originalname: string; buffer: Buffer };
async function plan(tx: Prisma.TransactionClient, businessId: string, supplierId: string, parsed: Awaited<ReturnType<typeof parseSupplierFile>>) {
  const supplier = await tx.supplier.findFirst({ where: { businessId, id: supplierId } });
  if (!supplier) throw new HttpError(404, "Không tìm thấy nhà cung cấp.");
  if (!supplier.isActive) throw new HttpError(409, "Nhà cung cấp đã ngừng hợp tác.");
  const variants = await tx.productVariant.findMany({
    where: { businessId, sku: { in: parsed.items.map(item => item.sku) } },
    include: { template: true, supplierProducts: { where: { businessId, supplierId } } },
  });
  const templates = await tx.productTemplate.findMany({ where: { businessId, name: { in: parsed.items.map(item => item.name) } } });
  const newUnits = new Map<string, string>();
  const items = parsed.items.map(line => {
    const existing = variants.find(variant => variant.sku === line.sku);
    const catalog = existing?.supplierProducts[0];
    const template = templates.find(item => item.name === line.name);
    const conflict = !existing && ((template && (!template.isActive || template.hasLotTracking || template.unitOfMeasure !== line.unit)) || (newUnits.has(line.name) && newUnits.get(line.name) !== line.unit));
    if (!existing) newUnits.set(line.name, line.unit);
    const error = line.error || (existing && (!existing.isActive || !existing.template.isActive) ? "SKU đã ngừng kinh doanh." : undefined)
      || (conflict ? "Tên sản phẩm đã có thiết lập khác. Hãy dùng SKU hiện có hoặc tên khác." : undefined);
    return { ...line, error, variantId: existing?.id ?? null, action: existing ? (catalog ? "update" : "link") : "create", currentName: existing?.template.name ?? null,
      // Include current state so a changed catalog requires a fresh preview.
      currentPrice: catalog?.supplyPrice.toFixed(2) ?? null, currentUpdatedAt: catalog?.updatedAt ?? null };
  });
  const digest = createHash("sha256").update(JSON.stringify({ businessId, supplierId, mapping: parsed.mapping, items, issues: parsed.issues })).digest("hex");
  return { ...parsed, items, digest, valid: !parsed.issues.length && !!items.length && items.every(item => !item.error) };
}

export async function previewSupplierImport(businessId: string, id: string, file: File, mapping?: unknown) {
  const supplierId = uuid(id, "supplierId");
  const parsed = await parseSupplierFile(file, mapping);
  return atomic(tx => plan(tx, businessId, supplierId, parsed));
}

export async function confirmSupplierImport(businessId: string, id: string, file: File, mapping: unknown, expectedDigest: unknown) {
  const supplierId = uuid(id, "supplierId");
  if (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new HttpError(400, "Hãy xem trước file trước khi nhập.");
  const parsed = await parseSupplierFile(file, mapping);
  return atomic(async tx => {
    const preview = await plan(tx, businessId, supplierId, parsed);
    if (preview.digest !== expectedDigest) throw new HttpError(409, "Dữ liệu đã thay đổi. Vui lòng xem trước lại.");
    if (!preview.valid) throw new HttpError(400, "Vui lòng sửa toàn bộ lỗi trong file trước khi nhập.");
    let created = 0; let linked = 0; let updated = 0;
    for (const line of preview.items) {
      let variantId = line.variantId;
      if (!variantId) {
        const template = await tx.productTemplate.upsert({ where: { businessId_name: { businessId, name: line.name } },
          create: { businessId, name: line.name, unitOfMeasure: line.unit }, update: {} });
        if (!template.isActive || template.unitOfMeasure !== line.unit || template.hasLotTracking) throw new HttpError(409, `Dòng ${line.row}: tên sản phẩm đã có thiết lập khác. Hãy dùng SKU hiện có hoặc tên khác.`);
        const variant = await tx.productVariant.create({ data: { businessId, templateId: template.id, sku: line.sku, basePrice: 0, costPrice: 0 } });
        variantId = variant.id; created++;
      } else if (line.action === "update") updated++; else linked++;
      const data = { supplierSku: line.supplierSku, supplierProductName: line.name, supplyPrice: line.price, isActive: true, priceUpdatedAt: new Date() };
      await tx.supplierProduct.upsert({ where: { businessId_supplierId_variantId: { businessId, supplierId, variantId } },
        create: { businessId, supplierId, variantId, ...data }, update: data });
    }
    return { created, linked, updated, total: preview.items.length };
  });
}
