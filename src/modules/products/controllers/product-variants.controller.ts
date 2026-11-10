import { Request, Response } from "express";
import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { BadRequestException, NotFoundException } from "../../../shared/exceptions/http-exceptions";
import { VariantGeneratorService } from "../services/variant-generator.service";

const service = new VariantGeneratorService();

const fail = (res: Response, err: any) => {
  console.error(err);
  return res.status(err.status || err.statusCode || 500).json({ message: err.message || "Lỗi hệ thống" });
};

const money = (value: unknown) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100) / 100;
};

export class ProductVariantsController {
  async generate(req: Request, res: Response) {
    try {
      const templateId = String(req.params.templateId || "");
      const body = req.body ?? {};
      const businessId = String(res.locals.businessId || "");
      if (!businessId) {
        return res.status(401).json({ message: "Bạn cần đăng nhập để tạo biến thể" });
      }

      const result = await service.generate({
        businessId,
        templateId,
        attributes: body.attributes,
        defaults: body.defaults,
        barcodeType: body.barcodeType,
      });

      return res.status(201).json({ message: "Sinh biến thể thành công", ...result });
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async bulkUpdate(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const templateId = String(req.params.templateId || "");
      const rows = Array.isArray(req.body?.variants) ? req.body.variants : [];
      if (rows.length === 0) throw new BadRequestException("Không có biến thể nào cần cập nhật");

      const variants = await prisma.productVariant.findMany({
        where: { businessId, templateId, id: { in: rows.map((row: any) => String(row.id)) } },
        select: { id: true },
      });
      const owned = new Set(variants.map((variant) => variant.id));

      const updates = rows.map((row: any, index: number) => {
        const id = String(row.id || "");
        if (!owned.has(id)) {
          throw new NotFoundException(`Biến thể dòng ${index + 1} không thuộc mẫu sản phẩm này`);
        }
        const costPrice = money(row.costPrice);
        const basePrice = money(row.basePrice);
        const safetyStockQty = Math.max(0, Math.trunc(Number(row.safetyStockQty) || 0));
        if (costPrice === null || basePrice === null) {
          throw new BadRequestException(`Giá của dòng ${index + 1} không hợp lệ`);
        }
        const patch: Record<string, any> = {
          costPrice,
          basePrice,
          safetyStockQty,
          updatedAt: new Date(),
        };
        if (row.isActive !== undefined) {
          patch.isActive = Boolean(row.isActive);
        }
        if (typeof row.sku === "string" && row.sku.trim()) {
          patch.sku = row.sku.trim();
        }
        if (row.barcode !== undefined) {
          patch.barcode = typeof row.barcode === "string" && row.barcode.trim() ? row.barcode.trim() : null;
        }
        return prisma.productVariant.update({
          where: { id },
          data: patch,
        });
      });

      const result = await prisma.$transaction(updates);
      return res.json({ updated: result.length });
    } catch (err: any) {
      if (err?.code === "P2002" || String(err?.message).includes("uq_variant_tenant_sku")) {
        return res.status(400).json({ message: "Mã SKU đã tồn tại trong hệ thống. Vui lòng chọn mã khác." });
      }
      return fail(res, err);
    }
  }
}
