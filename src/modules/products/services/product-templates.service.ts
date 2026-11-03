import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import {
  BadRequestException,
  NotFoundException,
} from "../../../shared/exceptions/http-exceptions";
import { Prisma } from "@prisma/client";

type TemplateInput = {
  code?: unknown;
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

    let code = text(data.code).toUpperCase();
    if (code) {
      const dupCode = await prisma.productTemplate.findFirst({ where: { businessId, code } });
      if (dupCode) throw new BadRequestException(`Mã sản phẩm "${code}" đã tồn tại trong cửa hàng`);
    } else {
      code = await nextTemplateCode(businessId);
    }

    const categoryId = await this.resolveCategory(businessId, data.categoryId);
    const template = await prisma.productTemplate.create({
      data: {
        businessId,
        code,
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
    if (data.code !== undefined) {
      const code = text(data.code).toUpperCase();
      if (!code) throw new BadRequestException("Mã mẫu sản phẩm không được để trống");
      const dupCode = await prisma.productTemplate.findFirst({
        where: { businessId, code, id: { not: templateId } },
      });
      if (dupCode) throw new BadRequestException(`Mã sản phẩm "${code}" đã tồn tại trong cửa hàng`);
      patch.code = code;
    }
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

  async delete(businessId: string, templateId: string) {
    const template = await prisma.productTemplate.findFirst({
      where: { id: templateId, businessId },
      include: {
        productVariants: {
          select: {
            id: true,
            _count: {
              select: {
                inventoryLedger: true,
                orderItems: true,
                purchaseOrderItems: true,
              },
            },
          },
        },
      },
    });
    if (!template) throw new NotFoundException("Không tìm thấy mẫu sản phẩm để xóa");

    // Kiểm tra xem đã có giao dịch kho hoặc đơn hàng chưa
    const hasTransactions = template.productVariants.some(
      (v) =>
        v._count.inventoryLedger > 0 ||
        v._count.orderItems > 0 ||
        v._count.purchaseOrderItems > 0
    );

    if (hasTransactions) {
      // Đã có lịch sử giao dịch: chuyển trạng thái thành ngừng kinh doanh để bảo toàn số liệu kế toán
      await prisma.productTemplate.update({
        where: { id: templateId },
        data: { isActive: false, updatedAt: new Date() },
      });
      await prisma.productVariant.updateMany({
        where: { templateId },
        data: { isActive: false, updatedAt: new Date() },
      });
      return {
        message: "Sản phẩm đã có lịch sử giao dịch kho/đơn hàng. Hệ thống đã chuyển sang trạng thái 'Ngừng bán'.",
        softDeleted: true,
      };
    }

    // Chưa có giao dịch: xóa sạch các bảng liên quan an toàn
    const variantIds = template.productVariants.map((v) => v.id);
    await prisma.$transaction(async (tx) => {
      if (variantIds.length > 0) {
        await tx.variantAttributeValue.deleteMany({ where: { variantId: { in: variantIds } } });
        await tx.inventoryBalance.deleteMany({ where: { variantId: { in: variantIds } } });
        await tx.productLot.deleteMany({ where: { variantId: { in: variantIds } } });
        await tx.productVariant.deleteMany({ where: { id: { in: variantIds } } });
      }
      await tx.productTemplate.delete({ where: { id: templateId } });
    });

    return { message: "Đã xóa hoàn toàn mẫu sản phẩm và các biến thể liên quan.", softDeleted: false };
  }
}
