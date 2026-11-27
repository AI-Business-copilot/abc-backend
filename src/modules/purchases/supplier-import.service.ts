import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { HttpError } from "../../shared/http/http-error";
import { uuid } from "./purchases.query";
import { atomic } from "./purchases-transaction";
import { parseSupplierFile } from "./supplier-import.parser";
import { upsertImportedCatalog } from "./supplier-import-catalog";

type File = { originalname: string; buffer: Buffer };
const templateSelect = { id: true, name: true, isActive: true, hasLotTracking: true, unitOfMeasure: true } as const;
async function plan(tx: Prisma.TransactionClient, businessId: string, supplierId: string, parsed: Awaited<ReturnType<typeof parseSupplierFile>>) {
  const supplier = await tx.supplier.findFirst({ where: { businessId, id: supplierId }, select: { isActive: true } });
  if (!supplier) throw new HttpError(404, "Không tìm thấy nhà cung cấp.");
  if (!supplier.isActive) throw new HttpError(409, "Nhà cung cấp đã ngừng hợp tác.");
  const variants = await tx.productVariant.findMany({
    where: { businessId, sku: { in: parsed.items.map(item => item.sku) } },
    select: {
      id: true, sku: true, isActive: true,
      template: { select: { name: true, isActive: true } },
      supplierProducts: { where: { businessId, supplierId }, select: { supplyPrice: true, updatedAt: true } },
    },
  });
  const templates = await tx.productTemplate.findMany({
    where: { businessId, name: { in: [...new Set(parsed.items.map(item => item.name))] } }, select: templateSelect,
  });
  const variantsBySku = new Map(variants.map(variant => [variant.sku, variant]));
  const templatesByName = new Map(templates.map(template => [template.name, template]));
  const newUnits = new Map<string, string>();
  const items = parsed.items.map(line => {
    const existing = variantsBySku.get(line.sku);
    const catalog = existing?.supplierProducts[0];
    const template = templatesByName.get(line.name);
    const conflict = !existing && ((template && (!template.isActive || template.hasLotTracking || template.unitOfMeasure !== line.unit)) || (newUnits.has(line.name) && newUnits.get(line.name) !== line.unit));
    if (!existing) newUnits.set(line.name, line.unit);
    const error = line.error || (existing && (!existing.isActive || !existing.template.isActive) ? "SKU đã ngừng kinh doanh." : undefined)
      || (conflict ? "Tên sản phẩm đã có thiết lập khác. Hãy dùng SKU hiện có hoặc tên khác." : undefined);
    return { ...line, error, variantId: existing?.id ?? null, action: existing ? (catalog ? "update" : "link") : "create", currentName: existing?.template.name ?? null,
      // Include current state so a changed catalog requires a fresh preview.
      currentPrice: catalog?.supplyPrice.toFixed(2) ?? null, currentUpdatedAt: catalog?.updatedAt ?? null };
  });
  const digest = createHash("sha256").update(JSON.stringify({ businessId, supplierId, mapping: parsed.mapping, items, issues: parsed.issues })).digest("hex");
  return {
    preview: { ...parsed, items, digest, valid: !parsed.issues.length && !!items.length && items.every(item => !item.error) },
    templatesByName,
  };
}

export async function previewSupplierImport(businessId: string, id: string, file: File, mapping?: unknown) {
  const supplierId = uuid(id, "supplierId");
  const parsed = await parseSupplierFile(file, mapping);
  return atomic(async tx => (await plan(tx, businessId, supplierId, parsed)).preview);
}

export async function confirmSupplierImport(businessId: string, id: string, file: File, mapping: unknown, expectedDigest: unknown) {
  const supplierId = uuid(id, "supplierId");
  if (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new HttpError(400, "Hãy xem trước file trước khi nhập.");
  const parsed = await parseSupplierFile(file, mapping);
  return atomic(async tx => {
    const { preview, templatesByName } = await plan(tx, businessId, supplierId, parsed);
    if (preview.digest !== expectedDigest) throw new HttpError(409, "Dữ liệu đã thay đổi. Vui lòng xem trước lại.");
    if (!preview.valid) throw new HttpError(400, "Vui lòng sửa toàn bộ lỗi trong file trước khi nhập.");
    const newLines = preview.items.filter(line => !line.variantId);
    const missingTemplates = new Map(newLines.filter(line => !templatesByName.has(line.name)).map(line => [line.name, line]));
    if (missingTemplates.size) {
      const createdTemplates = await tx.productTemplate.createManyAndReturn({
        data: [...missingTemplates.values()].map(line => ({ businessId, name: line.name, unitOfMeasure: line.unit })),
        select: templateSelect,
      });
      for (const template of createdTemplates) templatesByName.set(template.name, template);
    }
    const variantIdsBySku = new Map(preview.items.filter(line => line.variantId).map(line => [line.sku, line.variantId!]));
    if (newLines.length) {
      const createdVariants = await tx.productVariant.createManyAndReturn({
        data: newLines.map(line => {
          const template = templatesByName.get(line.name);
          if (!template || !template.isActive || template.hasLotTracking || template.unitOfMeasure !== line.unit) {
            throw new HttpError(409, `Dòng ${line.row}: tên sản phẩm đã có thiết lập khác. Hãy xem trước lại.`);
          }
          return { businessId, templateId: template.id, sku: line.sku, basePrice: 0, costPrice: 0 };
        }),
        select: { id: true, sku: true },
      });
      // RETURNING order is not guaranteed; associate IDs by SKU, never by index.
      for (const variant of createdVariants) variantIdsBySku.set(variant.sku, variant.id);
    }
    await upsertImportedCatalog(tx, businessId, supplierId, preview.items.map(line => {
      const variantId = variantIdsBySku.get(line.sku);
      if (!variantId) throw new HttpError(409, "Danh mục đã thay đổi. Vui lòng xem trước lại.");
      return { variantId, supplierSku: line.supplierSku, name: line.name, price: line.price };
    }));
    return {
      created: newLines.length,
      linked: preview.items.filter(line => line.action === "link").length,
      updated: preview.items.filter(line => line.action === "update").length,
      total: preview.items.length,
    };
  });
}
