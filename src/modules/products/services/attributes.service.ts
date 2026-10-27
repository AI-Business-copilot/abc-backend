import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { BadRequestException, NotFoundException } from "../../../shared/exceptions/http-exceptions";

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export class AttributesService {
  async create(businessId: string, data: any) {
    const name = text(data?.name);
    if (!businessId || !name) throw new BadRequestException("Tên thuộc tính là bắt buộc");
    if (name.length > 100) throw new BadRequestException("Tên thuộc tính tối đa 100 ký tự");
    const existing = await prisma.attribute.findFirst({ where: { businessId, name } });
    if (existing) throw new BadRequestException("Thuộc tính đã tồn tại");
    return prisma.attribute.create({ data: { businessId, name } });
  }

  async addValue(businessId: string, data: any) {
    const attributeId = text(data?.attributeId);
    const value = text(data?.value);
    if (!businessId || !attributeId || !value) throw new BadRequestException("Thiếu thông tin giá trị thuộc tính");
    if (value.length > 100) throw new BadRequestException("Giá trị thuộc tính tối đa 100 ký tự");

    const attribute = await prisma.attribute.findFirst({ where: { id: attributeId, businessId } });
    if (!attribute) throw new BadRequestException("Thuộc tính không thuộc cửa hàng này");

    const existing = await prisma.attributeValue.findFirst({ where: { attributeId, value } });
    if (existing) throw new BadRequestException("Giá trị thuộc tính đã tồn tại");

    return prisma.attributeValue.create({ data: { businessId, attributeId, value } });
  }

  async list(businessId: string) {
    if (!businessId) throw new BadRequestException("businessId la bat buoc");
    return prisma.attribute.findMany({
      where: { businessId },
      include: { attributeValues: { orderBy: { createdAt: "asc" } } },
      orderBy: { name: "asc" },
    });
  }

  async getById(businessId: string, id: string) {
    const attribute = await prisma.attribute.findFirst({
      where: { id, businessId },
      include: { attributeValues: { orderBy: { createdAt: "asc" } } },
    });
    if (!attribute) throw new NotFoundException("Không tìm thấy thuộc tính");
    return attribute;
  }

  async update(businessId: string, id: string, data: any) {
    const name = text(data?.name);
    if (!name) throw new BadRequestException("Tên thuộc tính là bắt buộc");
    if (name.length > 100) throw new BadRequestException("Tên thuộc tính tối đa 100 ký tự");

    const attribute = await prisma.attribute.findFirst({ where: { id, businessId } });
    if (!attribute) throw new NotFoundException("Không tìm thấy thuộc tính");

    const duplicate = await prisma.attribute.findFirst({
      where: { businessId, name, NOT: { id } },
    });
    if (duplicate) throw new BadRequestException("Thuộc tính đã tồn tại");

    return prisma.attribute.update({ where: { id }, data: { name } });
  }

  async remove(businessId: string, id: string) {
    const attribute = await prisma.attribute.findFirst({
      where: { id, businessId },
      include: { attributeValues: { select: { id: true } } },
    });
    if (!attribute) throw new NotFoundException("Không tìm thấy thuộc tính");

    const valueIds = attribute.attributeValues.map((value) => value.id);
    const [categoryLinks, variantLinks] = await Promise.all([
      prisma.categoryAttribute.count({ where: { attributeId: id } }),
      valueIds.length
        ? prisma.variantAttributeValue.count({ where: { attributeValueId: { in: valueIds } } })
        : Promise.resolve(0),
    ]);

    if (categoryLinks > 0 || variantLinks > 0) {
      throw new BadRequestException(
        "Không thể xóa: thuộc tính đang được danh mục hoặc biến thể sử dụng. Hãy gỡ liên kết trước.",
      );
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.attributeValue.deleteMany({ where: { attributeId: id } });
        await tx.attribute.delete({ where: { id } });
      },
      { timeout: 30000 },
    );

    return { id };
  }

  async updateValue(businessId: string, id: string, data: any) {
    const value = text(data?.value);
    if (!value) throw new BadRequestException("Giá trị thuộc tính là bắt buộc");
    if (value.length > 100) throw new BadRequestException("Giá trị thuộc tính tối đa 100 ký tự");

    const record = await prisma.attributeValue.findFirst({ where: { id, businessId } });
    if (!record) throw new NotFoundException("Không tìm thấy giá trị thuộc tính");

    const duplicate = await prisma.attributeValue.findFirst({
      where: { attributeId: record.attributeId, value, NOT: { id } },
    });
    if (duplicate) throw new BadRequestException("Giá trị thuộc tính đã tồn tại");

    return prisma.attributeValue.update({ where: { id }, data: { value } });
  }

  async removeValue(businessId: string, id: string) {
    const record = await prisma.attributeValue.findFirst({ where: { id, businessId } });
    if (!record) throw new NotFoundException("Không tìm thấy giá trị thuộc tính");

    const used = await prisma.variantAttributeValue.count({ where: { attributeValueId: id } });
    if (used > 0) {
      throw new BadRequestException("Không thể xóa: giá trị đang được biến thể sử dụng.");
    }

    await prisma.attributeValue.delete({ where: { id } });
    return { id };
  }
}
