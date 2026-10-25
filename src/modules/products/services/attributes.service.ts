import { prisma } from '../../../shared/infrastructure/database/prisma.client';
import { BadRequestException } from '../../../shared/exceptions/http-exceptions';

export class AttributesService {
  async create(data: any) {
    const { businessId, name } = data;
    if (!businessId || !name) throw new BadRequestException('businessId va name la bat buoc');
    const existing = await prisma.attribute.findFirst({ where: { businessId, name } });
    if (existing) throw new BadRequestException('Thuoc tinh da ton tai');
    const attr = await prisma.attribute.create({
      data: { businessId, name },
    });
    return attr;
  }

  async addValue(data: any) {
    const { businessId, attributeId, value } = data;
    if (!businessId || !attributeId || !value) throw new BadRequestException('Thieu thong tin');
    const attr = await prisma.attribute.findUnique({ where: { id: attributeId } });
    if (!attr) throw new BadRequestException('Khong tim thay thuoc tinh');
    if (attr.businessId !== businessId) throw new BadRequestException('Thuoc tinh khong thuoc business nay');
    const existing = await prisma.attributeValue.findFirst({ where: { attributeId, value } });
    if (existing) throw new BadRequestException('Gia tri thuoc tinh da ton tai');
    const val = await prisma.attributeValue.create({
      data: { businessId, attributeId, value },
    });
    return val;
  }

  async list(businessId: string) {
    if (!businessId) throw new BadRequestException('businessId la bat buoc');
    const attrs = await prisma.attribute.findMany({
      where: { businessId },
      include: { attributeValues: { orderBy: { createdAt: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    return attrs;
  }
}

