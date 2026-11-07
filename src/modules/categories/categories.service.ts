import { prisma } from "../../shared/infrastructure/database/prisma.client";
import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from "../../shared/exceptions/http-exceptions";

type CategoryRow = {
  id: string;
  name: string;
  code: string | null;
  parent_id: string | null;
  description: string | null;
  is_active: boolean | null;
  templates: number;
  variants: number;
};

type AttributeRow = {
  category_id: string;
  name: string;
};

export type CategoryNode = {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  level: 1 | 2;
  description: string | null;
  isActive: boolean;
  templateCount: number;
  variantCount: number;
  attributes: string[];
  children: CategoryNode[];
};

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");

const buildCode = (name: string) => {
  const compact = normalize(name).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `CAT-${compact.slice(0, 3) || "NEW"}`;
};

const cleanName = (value: unknown) => String(value ?? "").trim();

export class CategoriesService {
  async list(businessId: string) {
    if (!businessId) throw new BadRequestException("businessId la bat buoc");

    const rows = await prisma.$queryRaw<CategoryRow[]>`
      WITH tpl AS (
        SELECT category_id, COUNT(*)::int AS templates
          FROM product_templates
         WHERE business_id = ${businessId}::uuid
         GROUP BY category_id
      ),
      vrt AS (
        SELECT t.category_id, COUNT(v.id)::int AS variants
          FROM product_variants v
          JOIN product_templates t ON t.id = v.template_id
         WHERE v.business_id = ${businessId}::uuid
         GROUP BY t.category_id
      )
      SELECT c.id,
             c.name,
             c.code,
             c.parent_id,
             c.description,
             c.is_active,
             COALESCE(tpl.templates, 0)::int AS templates,
             COALESCE(vrt.variants, 0)::int AS variants
        FROM categories c
        LEFT JOIN tpl ON tpl.category_id = c.id
        LEFT JOIN vrt ON vrt.category_id = c.id
       WHERE c.business_id = ${businessId}::uuid
       ORDER BY c.name ASC
    `;

    const attributeRows = await prisma.$queryRaw<AttributeRow[]>`
      SELECT ca.category_id, a.name
        FROM category_attributes ca
        JOIN attributes a ON a.id = ca.attribute_id
       WHERE ca.business_id = ${businessId}::uuid
       ORDER BY a.name ASC
    `;

    const missing = await prisma.$queryRaw<{ total: number }[]>`
      SELECT COUNT(*)::int AS total
        FROM product_templates
       WHERE business_id = ${businessId}::uuid AND category_id IS NULL
    `;

    const attributesByCategory = new Map<string, string[]>();
    for (const row of attributeRows) {
      const current = attributesByCategory.get(row.category_id) ?? [];
      if (!current.includes(row.name)) current.push(row.name);
      attributesByCategory.set(row.category_id, current);
    }

    const nodeById = new Map<string, CategoryNode>();
    for (const row of rows) {
      nodeById.set(row.id, {
        id: row.id,
        code: row.code ?? buildCode(row.name),
        name: row.name,
        parentId: row.parent_id,
        level: row.parent_id ? 2 : 1,
        description: row.description,
        isActive: row.is_active !== false,
        templateCount: row.templates,
        variantCount: row.variants,
        attributes: attributesByCategory.get(row.id) ?? [],
        children: [],
      });
    }

    const roots: CategoryNode[] = [];
    for (const node of nodeById.values()) {
      if (node.parentId && nodeById.has(node.parentId)) {
        nodeById.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    for (const root of roots) {
      const inherited = root.attributes.slice();
      for (const child of root.children) {
        child.attributes = child.attributes.length > 0 ? child.attributes : inherited.slice();
        root.templateCount += child.templateCount;
        root.variantCount += child.variantCount;
      }
      const merged = new Set<string>(root.attributes);
      for (const child of root.children) {
        for (const attribute of child.attributes) merged.add(attribute);
      }
      root.attributes = [...merged];
      root.children.sort((a, b) => a.name.localeCompare(b.name, "vi"));
    }
    roots.sort((a, b) => a.name.localeCompare(b.name, "vi"));

    const total = rows.length;
    const active = rows.filter((row) => row.is_active !== false).length;

    return {
      stats: {
        total,
        active,
        missingProducts: missing[0]?.total ?? 0,
      },
      items: roots,
      parents: roots.map((root) => ({
        id: root.id,
        name: root.name,
        code: root.code,
      })),
    };
  }

  async create(
    businessId: string,
    input: {
      name?: unknown;
      level?: unknown;
      parentId?: unknown;
      description?: unknown;
    },
  ) {
    if (!businessId) throw new BadRequestException("businessId la bat buoc");

    const name = cleanName(input.name);
    if (!name) throw new BadRequestException("Ten danh muc la bat buoc");
    if (name.length > 150) throw new BadRequestException("Ten danh muc toi da 150 ky tu");

    const level = Number(input.level ?? (input.parentId ? 2 : 1));
    let parentId: string | null = null;

    if (level === 2) {
      parentId = String(input.parentId ?? "").trim();
      if (!parentId) throw new BadRequestException("Vui long chon danh muc cha");
      const parent = await prisma.category.findFirst({
        where: { id: parentId, businessId },
      });
      if (!parent) throw new BadRequestException("Khong tim thay danh muc cha");
      if (parent.parentId) {
        throw new BadRequestException("Chi ho tro phan cap 2 tang");
      }
    } else if (level !== 1) {
      throw new BadRequestException("Cap danh muc khong hop le");
    }

    const duplicated = await prisma.category.findFirst({
      where: { businessId, name },
    });
    if (duplicated) throw new HttpException(409, "Ten danh muc da ton tai");

    const code = await this.nextCode(businessId, name);
    const description = cleanName(input.description) || null;

    const created = await prisma.category.create({
      data: { businessId, name, code, parentId, description, isActive: true },
    });

    return { ...created, level: created.parentId ? 2 : 1 };
  }

  async update(
    businessId: string,
    categoryId: string,
    input: {
      name?: unknown;
      parentId?: unknown;
      description?: unknown;
      isActive?: unknown;
    },
  ) {
    const current = await prisma.category.findFirst({
      where: { id: categoryId, businessId },
    });
    if (!current) throw new NotFoundException("Khong tim thay danh muc");

    const data: {
      name?: string;
      parentId?: string | null;
      description?: string | null;
      isActive?: boolean;
      updatedAt?: Date;
    } = { updatedAt: new Date() };

    if (input.name !== undefined) {
      const name = cleanName(input.name);
      if (!name) throw new BadRequestException("Ten danh muc la bat buoc");
      if (name.length > 150) throw new BadRequestException("Ten danh muc toi da 150 ky tu");
      if (name !== current.name) {
        const duplicated = await prisma.category.findFirst({
          where: { businessId, name, id: { not: categoryId } },
        });
        if (duplicated) throw new HttpException(409, "Ten danh muc da ton tai");
        data.name = name;
      }
    }

    if (input.description !== undefined) {
      data.description = cleanName(input.description) || null;
    }

    if (input.isActive !== undefined) {
      data.isActive = Boolean(input.isActive);
    }

    if (input.parentId !== undefined) {
      const nextParentId = cleanName(input.parentId) || null;
      if (nextParentId === categoryId) {
        throw new BadRequestException("Danh muc khong the la cha cua chinh no");
      }
      if (nextParentId) {
        const hasChildren = await prisma.category.count({ where: { parentId: categoryId } });
        if (hasChildren > 0) {
          throw new BadRequestException("Danh muc dang co danh muc con, khong the chuyen thanh cap 2");
        }
        const parent = await prisma.category.findFirst({
          where: { id: nextParentId, businessId },
        });
        if (!parent) throw new BadRequestException("Khong tim thay danh muc cha");
        if (parent.parentId) throw new BadRequestException("Chi ho tro phan cap 2 tang");
      }
      data.parentId = nextParentId;
    }

    const updated = await prisma.category.update({
      where: { id: categoryId },
      data,
    });

    return { ...updated, level: updated.parentId ? 2 : 1 };
  }

  async remove(businessId: string, categoryId: string) {
    const current = await prisma.category.findFirst({
      where: { id: categoryId, businessId },
    });
    if (!current) throw new NotFoundException("Không tìm thấy danh mục yêu cầu.");

    const [children, templatesCount] = await Promise.all([
      prisma.category.count({ where: { parentId: categoryId } }),
      prisma.productTemplate.count({ where: { categoryId: categoryId } }),
    ]);

    if (children > 0) {
      throw new HttpException(409, "Danh mục đang có danh mục con trực thuộc. Vui lòng chuyển hoặc xóa các danh mục con trước khi xóa danh mục cha.");
    }

    // Nếu danh mục đang được gán cho các sản phẩm, tự động hủy gán (set categoryId = null)
    // để người dùng dễ dàng gán danh mục mới đồng loạt cho các sản phẩm này
    if (templatesCount > 0) {
      await prisma.productTemplate.updateMany({
        where: { categoryId, businessId },
        data: { categoryId: null },
      });
    }

    await prisma.category.delete({ where: { id: categoryId } });
    return { id: categoryId, unassignedProducts: templatesCount };
  }

  private async nextCode(businessId: string, name: string) {
    const base = buildCode(name);
    const existing = await prisma.category.findMany({
      where: { businessId, code: { startsWith: base } },
      select: { code: true },
    });
    const used = new Set(existing.map((item) => item.code));
    if (!used.has(base)) return base;

    let index = 2;
    while (used.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }
}
