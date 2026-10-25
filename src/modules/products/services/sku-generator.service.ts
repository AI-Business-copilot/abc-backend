// src/modules/products/services/sku-generator.service.ts
import { prisma } from "../../../shared/infrastructure/database/prisma.client";

function slugify(str: string, max = 6): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, max) || "PRD";
}

export class SkuGeneratorService {
  async generate(input: {
    businessId: string;
    templateName: string;
    // mảng các giá trị thuộc tính theo đúng thứ tự đã chọn
    valueLabels: string[];
  }): Promise<string> {
    const tplCode = slugify(input.templateName, 8);
    const attrCodes = input.valueLabels.map((v) => slugify(v, 4)).filter(Boolean);
    const base = [tplCode, ...attrCodes].join("-");

    let candidate = base;
    let counter = 1;
    // thử đến khi không trùng (business_id + sku)
    while (true) {
      const exists = await prisma.productVariant.findFirst({
        where: { businessId: input.businessId, sku: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
      candidate = `${base}-${String(counter).padStart(3, "0")}`;
      counter++;
      if (counter > 999) throw new Error("Không thể sinh SKU duy nhất, vui lòng kiểm tra lại quy tắc");
    }
  }

  // Dùng cho sản phẩm đơn
  async generateSingle(input: { businessId: string; templateName: string }): Promise<string> {
    return this.generate({ ...input, valueLabels: [] });
  }
}