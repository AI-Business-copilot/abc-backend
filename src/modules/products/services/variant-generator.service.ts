// src/modules/products/services/variant-generator.service.ts
import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { NotFoundException, BadRequestException } from "../../../shared/exceptions/http-exceptions";
import { cartesian } from "../utils/cartesian";
import { SkuGeneratorService } from "./sku-generator.service";
import { BarcodeGeneratorService } from "./barcode-generator.service";

interface ComboItem {
  attributeId: string;
  attributeValueId: string;
  attributeValue: { id: string; value: string; attributeId: string };
  attribute: { id: string; name: string };
}

export class VariantGeneratorService {
  private skuGen = new SkuGeneratorService();
  private barcodeGen = new BarcodeGeneratorService();

  async generate(params: {
    businessId: string;
    templateId: string;
    attributes?: Array<{ attributeId: string; attributeValueIds: string[] }>;
    defaults?: { basePrice?: number | string; costPrice?: number | string; isActive?: boolean };
    barcodeType?: "EAN13" | "CODE128";
  }) {
    const { businessId, templateId, attributes = [], defaults = {}, barcodeType = "EAN13" } = params;

    // 1) Kiểm tra template thuộc đúng business
    const template = await prisma.productTemplate.findFirst({
      where: { id: templateId, businessId },
    });
    if (!template) throw new NotFoundException("Không tìm thấy ProductTemplate trong cửa hàng này");

    // 2) Nếu không có thuộc tính -> sinh 1 SKU mặc định (sản phẩm đơn)
    if (attributes.length === 0 || attributes.every((a) => !a.attributeValueIds || a.attributeValueIds.length === 0)) {
      // kiểm tra đã tồn tại biến thể nào cho template này chưa? tuỳ nghiệp vụ
      const existingCount = await prisma.productVariant.count({ where: { businessId, templateId } });
      if (existingCount > 0) {
        throw new BadRequestException("Template này đã có biến thể. Nếu muốn thêm biến thể, vui lòng chọn thuộc tính.");
      }

      const sku = await this.skuGen.generateSingle({ businessId, templateName: template.name });
      const barcode = await this.barcodeGen.generate({ businessId, type: barcodeType });

      const variant = await prisma.$transaction(async (tx) => {
        const v = await tx.productVariant.create({
          data: {
            businessId,
            templateId,
            sku,
            barcode,
            basePrice: defaults.basePrice ?? 0,
            costPrice: defaults.costPrice ?? 0,
            isActive: defaults.isActive ?? true,
            // các field khác giữ default theo schema
          },
        });

        // khởi tạo tồn kho (không lot)
        await tx.inventoryBalance.create({
          data: {
            businessId,
            variantId: v.id,
            lotId: null,
            quantityOnHand: 0,
            damagedQuantity: 0,
          },
        });

        return v;
      });

      return { mode: "SINGLE", count: 1, variants: [variant] };
    }

    // 3) Có thuộc tính -> lấy đầy đủ attribute_value + attribute
    const attrValueLists: ComboItem[][] = [];
    for (const a of attributes) {
      if (!a.attributeValueIds.length) continue;
      const vals = await prisma.attributeValue.findMany({
        where: {
          attributeId: a.attributeId,
          id: { in: a.attributeValueIds },
          businessId, // đảm bảo cùng tenant
        },
        include: { attribute: true },
      });
      if (vals.length !== a.attributeValueIds.length) {
        throw new BadRequestException("Một số attributeValueId không hợp lệ hoặc không thuộc business này");
      }
      // giữ đúng thứ tự người dùng truyền để SKU nhất quán
      const ordered = a.attributeValueIds
        .map((id) => vals.find((v) => v.id === id))
        .filter(Boolean) as any[];
      attrValueLists.push(ordered.map((v) => ({ attributeId: a.attributeId, attributeValueId: v.id, attributeValue: v, attribute: v.attribute })));
    }

    if (attrValueLists.length === 0) throw new BadRequestException("Danh sách thuộc tính không hợp lệ");

    // 4) Tính tổ hợp Đề-các
    const combos = cartesian<ComboItem>(attrValueLists);

    // 5) Sinh biến thể trong transaction
    const created = await prisma.$transaction(async (tx) => {
      const result: any[] = [];
      for (const combo of combos) {
        // Kiểm tra xem tổ hợp này đã tồn tại cho template chưa
        // So sánh bằng cách: tìm variant có đúng bộ (attributeId, attributeValueId)
        const candidateVariantIds = await tx.variantAttributeValue.findMany({
          where: {
            attributeValueId: { in: combo.map((c) => c.attributeValueId) },
          },
          select: { variantId: true, attributeId: true, attributeValueId: true },
        });

        // gom theo variantId
        const mapByVariant = new Map<string, Set<string>>();
        for (const av of candidateVariantIds) {
          if (!mapByVariant.has(av.variantId)) mapByVariant.set(av.variantId, new Set());
          mapByVariant.get(av.variantId)!.add(`${av.attributeId}:${av.attributeValueId}`);
        }

        const comboKeySet = new Set(combo.map((c) => `${c.attributeId}:${c.attributeValueId}`));
        let isDuplicate = false;
        for (const [vid, set] of mapByVariant.entries()) {
          // kiểm tra variant thuộc template + business này và khớp 100% tổ hợp
          const v = await tx.productVariant.findFirst({
            where: { id: vid, templateId, businessId },
            select: { id: true },
          });
          if (!v) continue;
          if (set.size === comboKeySet.size) {
            // so sánh tập
            let match = true;
            for (const k of comboKeySet) if (!set.has(k)) { match = false; break; }
            if (match) { isDuplicate = true; break; }
          }
        }
        if (isDuplicate) continue; // bỏ qua tổ hợp đã có

        // sinh SKU + barcode
        const sku = await this.skuGen.generate({
          businessId,
          templateName: template.name,
          valueLabels: combo.map((c) => c.attributeValue.value),
        });
        const barcode = await this.barcodeGen.generate({ businessId, type: barcodeType });

        // tạo variant
        const variant = await tx.productVariant.create({
          data: {
            businessId,
            templateId,
            sku,
            barcode,
            basePrice: defaults.basePrice ?? 0,
            costPrice: defaults.costPrice ?? 0,
            isActive: defaults.isActive ?? true,
          },
        });

        // tạo mapping variant_attribute_values
        await tx.variantAttributeValue.createMany({
          data: combo.map((c) => ({
            variantId: variant.id,
            attributeId: c.attributeId,
            attributeValueId: c.attributeValueId,
          })),
        });

        // tạo inventory_balance
        await tx.inventoryBalance.create({
          data: {
            businessId,
            variantId: variant.id,
            lotId: null,
            quantityOnHand: 0,
            damagedQuantity: 0,
          },
        });

        result.push(variant);
      }
      return result;
    });

    return { mode: "VARIANTS", count: created.length, variants: created };
  }
}