import { prisma } from '../../../shared/infrastructure/database/prisma.client';
import { BadRequestException } from '../../../shared/exceptions/http-exceptions';

export class ProductTemplatesService {
  async create(data: any) {
    const { businessId, name, categoryId, unitOfMeasure, hasLotTracking } = data;
    if (!businessId || !name) throw new BadRequestException('businessId va name la bat buoc');
    const existing = await prisma.productTemplate.findFirst({ where: { businessId, name } });
    if (existing) throw new BadRequestException('Ten mau san pham da ton tai');
    const template = await prisma.productTemplate.create({
      data: {
        businessId,
        name,
        categoryId: categoryId || null,
        unitOfMeasure: unitOfMeasure || 'CAI',
        hasLotTracking: !!hasLotTracking,
        isActive: true,
      },
    });
    return template;
  }

  async list(businessId: string) {
    if (!businessId) throw new BadRequestException('businessId la bat buoc');
    return prisma.productTemplate.findMany({
      where: { businessId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string) {
    const template = await prisma.productTemplate.findUnique({ where: { id } });
    if (!template) throw new BadRequestException('Khong tim thay mau san pham');
    return template;
  }
}

