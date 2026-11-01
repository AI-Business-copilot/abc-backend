// src/modules/products/services/variant-generator.service.ts
import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { NotFoundException, BadRequestException } from "../../../shared/exceptions/http-exceptions";
import { cartesian } from "../utils/cartesian";

interface ComboItem {
  attributeId: string;
  attributeValueId: string;
  attributeValue: { id: string; value: string; attributeId: string };
  attribute: { id: string; name: string };
}

function calcEan13CheckDigit(d12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = parseInt(d12[i], 10);
    sum += i % 2 === 0 ? n : n * 3;
  }
  const mod = sum % 10;
  const check = mod === 0 ? 0 : 10 - mod;
  return check.toString();
}

function randomDigits(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

function slugify(str: string, max = 8): string {
  return (
    str
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "")
      .slice(0, max) || "PRD"
  );
}

export class VariantGeneratorService {
  private generateUniqueSku(
    base: string,
    usedSkus: Set<string>,
  ): string {
    let candidate = base;
    let counter = 1;
    while (usedSkus.has(candidate)) {
      candidate = `${base}-${String(counter).padStart(2, "0")}`;
      counter++;
      if (counter > 9999) break;
    }
    usedSkus.add(candidate);
    return candidate;
  }

  private generateUniqueBarcode(
    type: "EAN13" | "CODE128",
    usedBarcodes: Set<string>,
  ): string {
    let attempts = 0;
    while (attempts < 200) {
      attempts++;
      let barcode: string;
      if (type === "EAN13") {
        const prefix = "200";
        const rest = randomDigits(9);
        const d12 = prefix + rest;
        barcode = d12 + calcEan13CheckDigit(d12);
      } else {
        const ts = Date.now().toString().slice(-6);
        const rnd = randomDigits(6);
        barcode = `C128${ts}${rnd}`;
      }
      if (!usedBarcodes.has(barcode)) {
        usedBarcodes.add(barcode);
        return barcode;
      }
    }
    const fallback = `BC${Date.now()}${randomDigits(4)}`;
    usedBarcodes.add(fallback);
    return fallback;
  }

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

    // Lấy trước toàn bộ SKU và Barcode đã dùng trong tenant để tra cứu siêu tốc trong bộ nhớ (In-memory)
    const existingVariantsAll = await prisma.productVariant.findMany({
      where: { businessId },
      select: { sku: true, barcode: true },
    });
    const usedSkus = new Set(existingVariantsAll.map((v) => v.sku));
    const usedBarcodes = new Set(existingVariantsAll.map((v) => v.barcode).filter(Boolean) as string[]);

    // 2) Nếu không có thuộc tính -> sinh 1 SKU mặc định (sản phẩm đơn)
    if (attributes.length === 0 || attributes.every((a) => !a.attributeValueIds || a.attributeValueIds.length === 0)) {
      const existingCount = await prisma.productVariant.count({ where: { businessId, templateId } });
      if (existingCount > 0) {
        throw new BadRequestException("Mẫu này đã có biến thể. Nếu muốn thêm biến thể, vui lòng chọn thuộc tính.");
      }

      const tplCode = slugify(template.name, 10);
      const sku = this.generateUniqueSku(tplCode, usedSkus);
      const barcode = this.generateUniqueBarcode(barcodeType, usedBarcodes);

      const variant = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${templateId})::bigint)`;
          const v = await tx.productVariant.create({
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
        },
        { timeout: 60000, maxWait: 15000 },
      );

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
          businessId,
        },
        include: { attribute: true },
      });
      if (vals.length !== a.attributeValueIds.length) {
        throw new BadRequestException("Một số attributeValueId không hợp lệ hoặc không thuộc cửa hàng này");
      }
      const ordered = a.attributeValueIds
        .map((id) => vals.find((v) => v.id === id))
        .filter(Boolean) as any[];
      attrValueLists.push(
        ordered.map((v) => ({
          attributeId: a.attributeId,
          attributeValueId: v.id,
          attributeValue: v,
          attribute: v.attribute,
        })),
      );
    }

    if (attrValueLists.length === 0) throw new BadRequestException("Danh sách thuộc tính không hợp lệ");

    // 4) Tính tổ hợp Đề-các
    const combos = cartesian<ComboItem>(attrValueLists);

    // 5) Tối ưu hóa triệt để: Lấy toàn bộ biến thể hiện có của template đó 1 lần duy nhất trước khi lặp
    const currentVariants = await prisma.productVariant.findMany({
      where: { templateId, businessId },
      include: {
        variantAttributeValues: {
          select: { attributeId: true, attributeValueId: true },
        },
      },
    });

    const existingSignatures = new Set<string>();
    for (const v of currentVariants) {
      const sig = v.variantAttributeValues
        .map((x) => `${x.attributeId}:${x.attributeValueId}`)
        .sort()
        .join("|");
      existingSignatures.add(sig);
    }

    // Lọc ra các combo mới chưa từng tạo
    const newCombos: ComboItem[][] = [];
    for (const combo of combos) {
      const sig = combo
        .map((x) => `${x.attributeId}:${x.attributeValueId}`)
        .sort()
        .join("|");
      if (!existingSignatures.has(sig)) {
        newCombos.push(combo);
        existingSignatures.add(sig); // Đánh dấu tránh trùng lặp nội bộ
      }
    }

    if (newCombos.length === 0) {
      // Toàn bộ tổ hợp đã tồn tại
      return { mode: "VARIANTS", count: 0, variants: currentVariants };
    }

    // 6) Chuẩn bị trước SKU, Barcode cho các combo mới
    const tplCode = slugify(template.name, 8);
    const preparedItems = newCombos.map((combo) => {
      const attrCodes = combo.map((c) => slugify(c.attributeValue.value, 4)).filter(Boolean);
      const baseSku = [tplCode, ...attrCodes].join("-");
      const sku = this.generateUniqueSku(baseSku, usedSkus);
      const barcode = this.generateUniqueBarcode(barcodeType, usedBarcodes);
      return { combo, sku, barcode };
    });

    // 7) Ghi vào CSDL trong Transaction nhanh gọn không bị nghẽn
    const created = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${templateId})::bigint)`;
        const result: any[] = [];

        for (const item of preparedItems) {
          const variant = await tx.productVariant.create({
            data: {
              businessId,
              templateId,
              sku: item.sku,
              barcode: item.barcode,
              basePrice: defaults.basePrice ?? 0,
              costPrice: defaults.costPrice ?? 0,
              isActive: defaults.isActive ?? true,
            },
          });

          await tx.variantAttributeValue.createMany({
            data: item.combo.map((c) => ({
              variantId: variant.id,
              attributeId: c.attributeId,
              attributeValueId: c.attributeValueId,
            })),
          });

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
      },
      { timeout: 60000, maxWait: 15000 },
    );

    return { mode: "VARIANTS", count: created.length, variants: created };
  }
}
