import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { Prisma } from '@prisma/client';

export class ScrapService {
  /**
   * Generate unique scrap code for a business
   */
  private async generateScrapCode(businessId: string): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `SCRAP-${year}`;

    // Get last scrap order for this year
    const lastScrap = await prisma.scrapOrder.findFirst({
      where: {
        businessId,
        scrapCode: {
          startsWith: prefix,
        },
      },
      orderBy: {
        scrapCode: 'desc',
      },
    });

    let sequence = 1;
    if (lastScrap) {
      const lastSeq = parseInt(lastScrap.scrapCode.split('-')[2]) || 0;
      sequence = lastSeq + 1;
    }

    return `${prefix}-${String(sequence).padStart(5, '0')}`;
  }

  /**
   * Create a new scrap order (DRAFT status)
   */
  async createScrapOrder(
    businessId: string,
    userId: string,
    data: {
      variantId: string;
      lotId?: string;
      scrapQty: number;
      scrapSource: 'DAMAGED_STOCK' | 'SELLABLE_STOCK';
      scrapReason: string;
    },
  ): Promise<any> {
    // Validate input
    if (data.scrapQty <= 0) {
      throw new Error('Scrap quantity must be greater than 0');
    }

    if (!['DAMAGED_STOCK', 'SELLABLE_STOCK'].includes(data.scrapSource)) {
      throw new Error(
        'Invalid scrap source. Must be DAMAGED_STOCK or SELLABLE_STOCK',
      );
    }

    // Verify variant exists
    const variant = await prisma.productVariant.findUnique({
      where: { id: data.variantId },
    });

    if (!variant || variant.businessId !== businessId) {
      throw new Error('Variant not found');
    }

    // If lotId provided, verify lot exists
    if (data.lotId) {
      const lot = await prisma.productLot.findUnique({
        where: { id: data.lotId },
      });

      if (!lot || lot.businessId !== businessId) {
        throw new Error('Lot not found');
      }
    }

    // Get inventory balance and validate quantity available
    let inventory = await prisma.inventoryBalance.findFirst({
      where: {
        businessId,
        variantId: data.variantId,
        lotId: data.lotId || null,
      },
    });

    if (!inventory) {
      throw new Error(
        'No inventory balance found for this variant/lot combination',
      );
    }

    const availableQty =
      data.scrapSource === 'DAMAGED_STOCK'
        ? inventory.damagedQuantity
        : inventory.quantityOnHand;

    if (availableQty < data.scrapQty) {
      throw new Error(
        `Insufficient ${data.scrapSource === 'DAMAGED_STOCK' ? 'damaged' : 'sellable'} quantity. Available: ${availableQty}, Requested: ${data.scrapQty}`,
      );
    }

    // Get unit cost from variant
    const unitCost = variant.costPrice || 0;

    const scrapCode = await this.generateScrapCode(businessId);

    return prisma.scrapOrder.create({
      data: {
        businessId,
        scrapCode,
        variantId: data.variantId,
        lotId: data.lotId,
        scrapQty: data.scrapQty,
        unitCost: new Prisma.Decimal(unitCost),
        scrapSource: data.scrapSource,
        scrapReason: data.scrapReason,
        status: 'DRAFT',
        createdBy: userId,
      },
      include: {
        variant: {
          select: {
            id: true,
            sku: true,
            name: true,
            costPrice: true,
          },
        },
        lot: {
          select: {
            id: true,
            lotNumber: true,
            expirationDate: true,
          },
        },
        createdByUser: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
      },
    });
  }

  /**
   * Get all scrap orders with filtering
   */
  async getScrapOrders(
    businessId: string,
    filters?: {
      status?: string;
      scrapSource?: string;
      startDate?: Date;
      endDate?: Date;
      skip?: number;
      take?: number;
    },
  ): Promise<{ orders: any[]; total: number }> {
    const take = filters?.take || 20;
    const skip = filters?.skip || 0;

    const where: any = { businessId };

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.scrapSource) {
      where.scrapSource = filters.scrapSource;
    }

    if (filters?.startDate || filters?.endDate) {
      where.createdAt = {};
      if (filters.startDate) {
        where.createdAt.gte = filters.startDate;
      }
      if (filters.endDate) {
        where.createdAt.lte = filters.endDate;
      }
    }

    const [orders, total] = await Promise.all([
      prisma.scrapOrder.findMany({
        where,
        include: {
          variant: {
            select: {
              id: true,
              sku: true,
              name: true,
            },
          },
          lot: {
            select: {
              id: true,
              lotNumber: true,
              expirationDate: true,
            },
          },
          createdByUser: {
            select: {
              id: true,
              fullName: true,
              email: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take,
      }),
      prisma.scrapOrder.count({ where }),
    ]);

    return { orders, total };
  }

  /**
   * Get a single scrap order
   */
  async getScrapOrder(businessId: string, scrapOrderId: string): Promise<any> {
    const order = await prisma.scrapOrder.findUnique({
      where: { id: scrapOrderId },
      include: {
        variant: {
          select: {
            id: true,
            sku: true,
            name: true,
            costPrice: true,
          },
        },
        lot: {
          select: {
            id: true,
            lotNumber: true,
            expirationDate: true,
          },
        },
        createdByUser: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
      },
    });

    if (!order || order.businessId !== businessId) {
      throw new Error('Scrap order not found');
    }

    return order;
  }

  /**
   * Update a scrap order (only while DRAFT)
   */
  async updateScrapOrder(
    businessId: string,
    scrapOrderId: string,
    data: {
      scrapQty?: number;
      scrapReason?: string;
    },
  ): Promise<any> {
    const order = await this.getScrapOrder(businessId, scrapOrderId);

    if (order.status !== 'DRAFT') {
      throw new Error(
        `Cannot update scrap order with status ${order.status}. Only DRAFT orders can be updated.`,
      );
    }

    if (data.scrapQty !== undefined) {
      if (data.scrapQty <= 0) {
        throw new Error('Scrap quantity must be greater than 0');
      }

      // Validate new quantity against inventory
      const inventory = await prisma.inventoryBalance.findFirst({
        where: {
          businessId,
          variantId: order.variantId,
          lotId: order.lotId || null,
        },
      });

      if (!inventory) {
        throw new Error('Inventory balance not found');
      }

      const availableQty =
        order.scrapSource === 'DAMAGED_STOCK'
          ? inventory.damagedQuantity
          : inventory.quantityOnHand;

      if (availableQty < data.scrapQty) {
        throw new Error(
          `Insufficient quantity available. Available: ${availableQty}, Requested: ${data.scrapQty}`,
        );
      }
    }

    return prisma.scrapOrder.update({
      where: { id: scrapOrderId },
      data,
      include: {
        variant: {
          select: {
            id: true,
            sku: true,
            name: true,
          },
        },
        lot: {
          select: {
            id: true,
            lotNumber: true,
            expirationDate: true,
          },
        },
      },
    });
  }

  /**
   * Delete a scrap order (only DRAFT)
   */
  async deleteScrapOrder(businessId: string, scrapOrderId: string): Promise<void> {
    const order = await this.getScrapOrder(businessId, scrapOrderId);

    if (order.status !== 'DRAFT') {
      throw new Error(
        `Cannot delete scrap order with status ${order.status}. Only DRAFT orders can be deleted.`,
      );
    }

    await prisma.scrapOrder.delete({
      where: { id: scrapOrderId },
    });
  }

  /**
   * Approve and execute scrap order (atomic transaction)
   * Reduces inventory, creates ledger entry, marks lot as SCRAPPED
   */
  async approveScrapOrder(
    businessId: string,
    scrapOrderId: string,
    userId: string,
  ): Promise<any> {
    const order = await this.getScrapOrder(businessId, scrapOrderId);

    if (order.status !== 'DRAFT') {
      throw new Error(
        `Cannot approve scrap order with status ${order.status}. Only DRAFT orders can be approved.`,
      );
    }

    // Execute as atomic transaction
    return prisma.$transaction(async (tx) => {
      // 1. Get current inventory
      const inventory = await tx.inventoryBalance.findFirst({
        where: {
          businessId,
          variantId: order.variantId,
          lotId: order.lotId || null,
        },
      });

      if (!inventory) {
        throw new Error('Inventory balance not found');
      }

      // 2. Validate inventory still available
      const availableQty =
        order.scrapSource === 'DAMAGED_STOCK'
          ? inventory.damagedQuantity
          : inventory.quantityOnHand;

      if (availableQty < order.scrapQty) {
        throw new Error(
          `Insufficient quantity available. Available: ${availableQty}, Requested: ${order.scrapQty}`,
        );
      }

      // 3. Reduce inventory based on source
      const updateData: any = {};
      if (order.scrapSource === 'DAMAGED_STOCK') {
        updateData.damagedQuantity = inventory.damagedQuantity - order.scrapQty;
      } else {
        updateData.quantityOnHand =
          inventory.quantityOnHand - order.scrapQty;
      }
      updateData.updatedAt = new Date();

      await tx.inventoryBalance.update({
        where: { id: inventory.id },
        data: updateData,
      });

      // 4. Create inventory ledger entry
      const totalCostValue = order.scrapQty * Number(order.unitCost);

      await tx.inventoryLedger.create({
        data: {
          businessId,
          variantId: order.variantId,
          lotId: order.lotId,
          transactionType: 'SCRAP_DISPOSAL',
          quantityChanged: -order.scrapQty,
          balanceAfter: 0, // Will be recalculated by app
          unitCost: order.unitCost,
          totalCostValue: new Prisma.Decimal(totalCostValue),
          referenceDocType: 'SCRAP_ORDER',
          referenceDocId: scrapOrderId,
          createdBy: userId,
        },
      });

      // 5. Update lot status to SCRAPPED if lot exists
      if (order.lotId) {
        await tx.productLot.update({
          where: { id: order.lotId },
          data: {
            status: 'SCRAPPED',
          },
        });
      }

      // 6. Update scrap order status
      const updatedOrder = await tx.scrapOrder.update({
        where: { id: scrapOrderId },
        data: {
          status: 'COMPLETED',
        },
        include: {
          variant: {
            select: {
              id: true,
              sku: true,
              name: true,
            },
          },
          lot: {
            select: {
              id: true,
              lotNumber: true,
            },
          },
        },
      });

      return {
        scrapOrder: updatedOrder,
        inventoryReduced: order.scrapQty,
        lossAmount: totalCostValue,
        ledgerCreated: true,
      };
    });
  }

  /**
   * Reject scrap order
   */
  async rejectScrapOrder(
    businessId: string,
    scrapOrderId: string,
    rejectionReason?: string,
  ): Promise<any> {
    const order = await this.getScrapOrder(businessId, scrapOrderId);

    if (order.status !== 'DRAFT') {
      throw new Error(
        `Cannot reject scrap order with status ${order.status}. Only DRAFT orders can be rejected.`,
      );
    }

    const notes = rejectionReason
      ? `Rejected: ${rejectionReason}`
      : 'Rejected by owner';

    return prisma.scrapOrder.update({
      where: { id: scrapOrderId },
      data: {
        status: 'CANCELLED',
        scrapReason: notes,
      },
    });
  }

  /**
   * Get scrap order statistics for a business
   */
  async getScrapStatistics(businessId: string): Promise<{
    draftCount: number;
    completedCount: number;
    totalLossValue: number;
    bySource: Record<string, number>;
  }> {
    const orders = await prisma.scrapOrder.findMany({
      where: { businessId },
    });

    const draftCount = orders.filter((o) => o.status === 'DRAFT').length;
    const completedCount = orders.filter((o) => o.status === 'COMPLETED').length;

    let totalLossValue = 0;
    orders.forEach((o) => {
      if (o.totalLossValue) {
        totalLossValue += Number(o.totalLossValue);
      }
    });

    const bySource = {
      DAMAGED_STOCK: orders.filter((o) => o.scrapSource === 'DAMAGED_STOCK')
        .length,
      SELLABLE_STOCK: orders.filter((o) => o.scrapSource === 'SELLABLE_STOCK')
        .length,
    };

    return {
      draftCount,
      completedCount,
      totalLossValue,
      bySource,
    };
  }
}
