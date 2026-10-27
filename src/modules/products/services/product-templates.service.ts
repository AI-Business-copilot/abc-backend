import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import {
  BadRequestException,
  NotFoundException,
} from "../../../shared/exceptions/http-exceptions";
import { Prisma } from "@prisma/client";

type TemplateInput = {
  name?: unknown;
  categoryId?: unknown;
  unitOfMeasure?: unknown;
  hasLotTracking?: unknown;
  description?: unknown;
  imageUrl?: unknown;
  isActive?: unknown;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

async function nextTemplateCode(businessId: string) {
  const year = new Date().getFullYear();
  const prefix = `TMP-${year}-`;
  const last = await prisma.productTemplate.findFirst({
    where: { businessId, code: { startsWith: prefix } },
    orderBy: { code: "desc" },
    select: { code: true },
  });
  const sequence = last?.code ? Number(last.code.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(Number.isFinite(sequence) ? sequence : 1).padStart(4, "0")}`;
}

export class ProductTemplatesService {
  private async resolveCategory(businessId: string, categoryId: unknown) {
    if (!categoryId) return null;
    const id = text(categoryId);
    if (!id) return null;
    const category = await prisma.category.findFirst({ where: { id, businessId } });
    if (!category) throw new BadRequestException("Danh mục không thuộc cửa hàng hiện tại");
    return category.id;
  }

  async create(businessId: string, data: TemplateInput) {
    const name = text(data.name);
    if (!businessId || !name) throw new BadRequestException("Tên mẫu sản phẩm là bắt buộc");
    if (name.length > 255) throw new BadRequestException("Tên mẫu sản phẩm tối đa 255 ký tự");

    const duplicate = await prisma.productTemplate.findFirst({ where: { businessId, name } });
    if (duplicate) throw new BadRequestException("Tên mẫu sản phẩm đã tồn tại");

    const categoryId = await this.resolveCategory(businessId, data.categoryId);
    const template = await prisma.productTemplate.create({
      data: {
        businessId,
        code: await nextTemplateCode(businessId),
        name,
        categoryId,
        unitOfMeasure: text(data.unitOfMeasure) || "Cái",
        hasLotTracking: Boolean(data.hasLotTracking),
        description: text(data.description) || null,
        imageUrl: text(data.imageUrl) || null,
        isActive: data.isActive === undefined ? true : Boolean(data.isActive),
      },
    });
    return template;
  }

  async update(businessId: string, templateId: string, data: TemplateInput) {
    const template = await prisma.productTemplate.findFirst({
      where: { id: templateId, businessId },
      include: { _count: { select: { productVariants: true } } },
    });
    if (!template) throw new NotFoundException("Không tìm thấy mẫu sản phẩm");

    const patch: Prisma.ProductTemplateUncheckedUpdateInput = {};
    if (data.name !== undefined) {
      const name = text(data.name);
      if (!name) throw new BadRequestException("Tên mẫu sản phẩm là bắt buộc");
      const duplicate = await prisma.productTemplate.findFirst({
        where: { businessId, name, id: { not: templateId } },
      });
      if (duplicate) throw new BadRequestException("Tên mẫu sản phẩm đã tồn tại");
      patch.name = name;
    }
    if (data.categoryId !== undefined) {
      patch.categoryId = await this.resolveCategory(businessId, data.categoryId);
    }
    if (data.unitOfMeasure !== undefined) {
      patch.unitOfMeasure = text(data.unitOfMeasure) || "Cái";
    }
    if (data.hasLotTracking !== undefined) {
      patch.hasLotTracking = Boolean(data.hasLotTracking);
    }
    if (data.description !== undefined) {
      patch.description = text(data.description) || null;
    }
    if (data.imageUrl !== undefined) {
      patch.imageUrl = text(data.imageUrl) || null;
    }
    if (data.isActive !== undefined) {
      const isActive = Boolean(data.isActive);
      if (isActive && template._count.productVariants === 0) {
        throw new BadRequestException("Cần sinh ít nhất một biến thể trước khi đưa sản phẩm vào kinh doanh");
      }
      patch.isActive = isActive;
    }

    return prisma.productTemplate.update({
      where: { id: templateId },
      data: { ...patch, updatedAt: new Date() },
    });
  }

  async list(businessId: string) {
    if (!businessId) throw new BadRequestException("businessId la bat buoc");
    return prisma.productTemplate.findMany({
      where: { businessId },
      include: { _count: { select: { productVariants: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async getById(businessId: string, templateId: string) {
    const template = await prisma.productTemplate.findFirst({
      where: { id: templateId, businessId },
      include: {
        category: { include: { parent: true } },
        productVariants: {
          include: {
            variantAttributeValues: {
              include: {
                attribute: { select: { id: true, name: true } },
                attributeValue: { select: { id: true, value: true } },
              },
            },
            inventoryBalances: { select: { quantityOnHand: true, lotId: true } },
          },
          orderBy: { sku: "asc" },
        },
      },
    });
    if (!template) throw new NotFoundException("Không tìm thấy mẫu sản phẩm");
    return template;
  }
}
