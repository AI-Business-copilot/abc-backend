import { Request, Response } from 'express';
import { prisma } from '../../../shared/infrastructure/database/prisma.client';

const num = (v: any) => Number(v ?? 0);

export class ProductListController {
  async list(req: Request, res: Response) {
    try {
      const businessId = req.query.businessId as string;
      if (!businessId) return res.status(400).json({ message: 'businessId là bắt buộc' });

      const keyword = String(req.query.q || '').trim().toLowerCase();
      const categoryId = String(req.query.categoryId || '').trim();
      const status = String(req.query.status || '').trim();
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(60, Math.max(1, Number(req.query.pageSize) || 12));

      const [templates, categories] = await Promise.all([
        prisma.productTemplate.findMany({
          where: { businessId },
          include: {
            category: { include: { parent: true } },
            productVariants: {
              where: { isActive: true },
              include: { inventoryBalances: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.category.findMany({ where: { businessId }, include: { parent: true }, orderBy: { name: 'asc' } }),
      ]);

      const mapped = templates.map((t: any) => {
        const variants = t.productVariants || [];
        const stockQty = variants.reduce(
          (sum: number, v: any) => sum + (v.inventoryBalances || []).reduce((s: number, b: any) => s + num(b.quantityOnHand), 0),
          0
        );
        const stockValue = variants.reduce(
          (sum: number, v: any) =>
            sum + (v.inventoryBalances || []).reduce((s: number, b: any) => s + num(b.quantityOnHand) * num(v.costPrice), 0),
          0
        );
        const retailValue = variants.reduce(
          (sum: number, v: any) =>
            sum + (v.inventoryBalances || []).reduce((s: number, b: any) => s + num(b.quantityOnHand) * num(v.basePrice), 0),
          0
        );
        const avgCost = variants.length
          ? Math.round(variants.reduce((s: number, v: any) => s + num(v.costPrice), 0) / variants.length / 1000) * 1000
          : 0;
        const avgPrice = variants.length
          ? Math.round(variants.reduce((s: number, v: any) => s + num(v.basePrice), 0) / variants.length / 1000) * 1000
          : 0;

        const categoryPath = t.category
          ? t.category.parent
            ? `${t.category.parent.name} > ${t.category.name}`
            : t.category.name
          : null;

        return {
          id: t.id,
          code: t.code || `TMP-${t.id.slice(0, 6).toUpperCase()}`,
          name: t.name,
          description: t.description,
          imageUrl: t.imageUrl,
          unitOfMeasure: t.unitOfMeasure || 'cái',
          hasLotTracking: !!t.hasLotTracking,
          isActive: t.isActive !== false,
          categoryId: t.categoryId,
          categoryName: t.category?.name || null,
          categoryPath,
          variantCount: variants.length,
          stockQty,
          stockValue,
          retailValue,
          avgCost,
          avgPrice,
          skus: variants.map((v: any) => ({
            id: v.id,
            sku: v.sku,
            barcode: v.barcode,
            basePrice: num(v.basePrice),
            costPrice: num(v.costPrice),
            stockQty: (v.inventoryBalances || []).reduce((s: number, b: any) => s + num(b.quantityOnHand), 0),
          })),
        };
      });

      const activeCount = mapped.filter((m) => m.isActive).length;
      const totalStockValue = mapped.reduce((s, m) => s + m.stockValue, 0);
      const totalRetailValue = mapped.reduce((s, m) => s + m.retailValue, 0);
      const totalVariants = mapped.reduce((s, m) => s + m.variantCount, 0);

      const level1 = categories.filter((c) => !c.parentId);
      const level2 = categories.filter((c) => !!c.parentId);

      const parentCounts = level1
        .map((parent: any) => ({
          id: parent.id,
          name: parent.name,
          count: mapped.filter((m) => {
            const cat = categories.find((c: any) => c.id === m.categoryId);
            return cat && (cat.id === parent.id || cat.parentId === parent.id);
          }).length,
        }))
        .sort((a, b) => b.count - a.count);

      const stats = {
        totalTemplates: mapped.length,
        totalVariants,
        totalCategories: categories.length,
        level1Count: level1.length,
        level2Count: level2.length,
        activePercent: mapped.length ? Math.round((activeCount / mapped.length) * 100) : 0,
        totalStockValue: Math.round(totalStockValue),
        grossMarginPercent: totalRetailValue > 0 ? Math.round(((totalRetailValue - totalStockValue) / totalRetailValue) * 100) : 0,
        missingCategoryCount: mapped.filter((m) => !m.categoryId).length,
        topCategories: parentCounts.slice(0, 2),
      };

      const categoryOptions = categories.map((c: any) => ({
        id: c.id,
        name: c.name,
        parentId: c.parentId,
        parentName: c.parent?.name || null,
        count: mapped.filter((m) =>
          c.parentId ? m.categoryId === c.id : m.categoryId === c.id || categories.some((x: any) => x.id === m.categoryId && x.parentId === c.id)
        ).length,
      }));

      let items = mapped;
      if (keyword) {
        items = items.filter(
          (m) =>
            m.name.toLowerCase().includes(keyword) ||
            m.code.toLowerCase().includes(keyword) ||
            (m.skus || []).some((s: any) => String(s.sku).toLowerCase().includes(keyword) || String(s.barcode || '').includes(keyword))
        );
      }
      if (categoryId) {
        const childIds = categories.filter((c: any) => c.parentId === categoryId).map((c: any) => c.id);
        items = items.filter((m) => m.categoryId === categoryId || childIds.includes(m.categoryId));
      }
      if (status === 'active') items = items.filter((m) => m.isActive);
      if (status === 'inactive') items = items.filter((m) => !m.isActive);
      if (status === 'missing-category') items = items.filter((m) => !m.categoryId);

      const total = items.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages);
      const paged = items.slice((safePage - 1) * pageSize, safePage * pageSize);

      return res.json({
        stats,
        categories: categoryOptions,
        items: paged,
        pagination: { page: safePage, pageSize, total, totalPages },
      });
    } catch (err: any) {
      console.error(err);
      return res.status(500).json({ message: err.message || 'Lỗi hệ thống' });
    }
  }
}
