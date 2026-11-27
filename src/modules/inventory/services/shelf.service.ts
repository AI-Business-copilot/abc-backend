import type { Prisma } from "@prisma/client";

import { prisma } from "../../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../../shared/http/http-error";

/** The part of Prisma the cell writer needs, so it can run inside a transaction too. */
type ShelfCellWriter = {
  inventoryShelfCell: Prisma.TransactionClient["inventoryShelfCell"];
};

/** A shelf with the cells (positions) it holds. */
export interface ShelfCellView {
  id: string;
  level: number;
  slot: number;
  isActive: boolean;
  /** How many lot items sit on this position. */
  itemCount: number;
}

export interface ShelfView {
  id: string;
  code: string;
  name: string | null;
  isActive: boolean;
  cells: ShelfCellView[];
  /** How many lot items sit on this shelf, across all its cells. */
  itemCount: number;
}

const cleanText = (value: unknown): string => String(value ?? "").trim();

/** The shelf code is what the staff say out loud, so it is stored as typed, uppercased. */
function normalizeCode(value: unknown): string {
  return cleanText(value).toUpperCase();
}

/** Levels and slots are 1-based positions: level 1 is the bottom of the shelf. */
function parsePosition(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new HttpError(400, `${label} phai la so nguyen tu 1 tro len.`);
  }
  return number;
}

export class ShelfService {
  /** Every shelf of the business, with the cells it holds and how many lots sit on it. */
  async list(businessId: string): Promise<ShelfView[]> {
    const shelves = await prisma.inventoryShelf.findMany({
      where: { businessId },
      orderBy: { code: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        isActive: true,
        cells: {
          select: {
            id: true,
            level: true,
            slot: true,
            isActive: true,
            _count: { select: { items: true } },
          },
          orderBy: [{ level: "asc" }, { slot: "asc" }],
        },
      },
    });

    return shelves.map((shelf) => ({
      id: shelf.id,
      code: shelf.code,
      name: shelf.name,
      isActive: shelf.isActive,
      cells: shelf.cells.map((cell) => ({
        id: cell.id,
        level: cell.level,
        slot: cell.slot,
        isActive: cell.isActive,
        itemCount: cell._count.items,
      })),
      itemCount: shelf.cells.reduce((sum, cell) => sum + cell._count.items, 0),
    }));
  }

  /** Create a shelf. The code is unique inside the business. */
  async create(businessId: string, body: { code?: unknown; name?: unknown }): Promise<ShelfView> {
    const code = normalizeCode(body.code);
    if (!code) {
      throw new HttpError(400, "Ma ke la bat buoc.");
    }

    const existing = await prisma.inventoryShelf.findFirst({
      where: { businessId, code },
      select: { id: true },
    });
    if (existing) {
      throw new HttpError(409, `Ma ke "${code}" da ton tai trong cua hang nay.`);
    }

    const name = cleanText(body.name) || null;
    const created = await prisma.inventoryShelf.create({
      data: { businessId, code, name },
      select: { id: true, code: true, name: true, isActive: true },
    });

    return { ...created, cells: [], itemCount: 0 };
  }

  /** Rename a shelf or change its code. The code stays unique inside the business. */
  async update(
    businessId: string,
    shelfId: string,
    body: { code?: unknown; name?: unknown },
  ): Promise<ShelfView> {
    const shelf = await prisma.inventoryShelf.findFirst({
      where: { id: shelfId, businessId },
      select: { id: true },
    });
    if (!shelf) {
      throw new HttpError(404, "Khong tim thay ke.");
    }

    const data: { code?: string; name?: string | null } = {};
    if (body.code !== undefined) {
      const code = normalizeCode(body.code);
      if (!code) {
        throw new HttpError(400, "Ma ke la bat buoc.");
      }
      const duplicate = await prisma.inventoryShelf.findFirst({
        where: { businessId, code, id: { not: shelfId } },
        select: { id: true },
      });
      if (duplicate) {
        throw new HttpError(409, `Ma ke "${code}" da ton tai trong cua hang nay.`);
      }
      data.code = code;
    }
    if (body.name !== undefined) {
      data.name = cleanText(body.name) || null;
    }

    const updated = await prisma.inventoryShelf.update({
      where: { id: shelfId },
      data: { ...data, updatedAt: new Date() },
      select: {
        id: true,
        code: true,
        name: true,
        isActive: true,
        cells: {
          select: {
            id: true,
            level: true,
            slot: true,
            isActive: true,
            _count: { select: { items: true } },
          },
          orderBy: [{ level: "asc" }, { slot: "asc" }],
        },
      },
    });

    return {
      id: updated.id,
      code: updated.code,
      name: updated.name,
      isActive: updated.isActive,
      cells: updated.cells.map((cell) => ({
        id: cell.id,
        level: cell.level,
        slot: cell.slot,
        isActive: cell.isActive,
        itemCount: cell._count.items,
      })),
      itemCount: updated.cells.reduce((sum, cell) => sum + cell._count.items, 0),
    };
  }

  /**
   * Delete a shelf. It is only deactivated: the lot items still point at its cells, and a hard
   * delete would leave them without a location.
   */
  async remove(businessId: string, shelfId: string): Promise<void> {
    const shelf = await prisma.inventoryShelf.findFirst({
      where: { id: shelfId, businessId },
      select: { id: true },
    });
    if (!shelf) {
      throw new HttpError(404, "Khong tim thay ke.");
    }

    await prisma.$transaction(async (tx) => {
      await tx.inventoryShelfCell.updateMany({
        where: { shelfId },
        data: { isActive: false },
      });
      await tx.inventoryShelf.update({
        where: { id: shelfId },
        data: { isActive: false, updatedAt: new Date() },
      });
    });
  }

  /** Create a cell (position) on a shelf. The same position is never created twice. */
  async createCell(
    businessId: string,
    shelfId: string,
    body: { level?: unknown; slot?: unknown },
  ): Promise<ShelfCellView> {
    const shelf = await prisma.inventoryShelf.findFirst({
      where: { id: shelfId, businessId },
      select: { id: true },
    });
    if (!shelf) {
      throw new HttpError(404, "Khong tim thay ke.");
    }

    const level = parsePosition(body.level, "Tang");
    const slot = parsePosition(body.slot, "O");

    const existing = await prisma.inventoryShelfCell.findFirst({
      where: { shelfId, level, slot },
      select: { id: true },
    });
    if (existing) {
      throw new HttpError(409, `O ke tang ${level} - o ${slot} da ton tai tren ke nay.`);
    }

    const created = await prisma.inventoryShelfCell.create({
      data: { businessId, shelfId, level, slot },
      select: {
        id: true,
        level: true,
        slot: true,
        isActive: true,
        _count: { select: { items: true } },
      },
    });

    return {
      id: created.id,
      level: created.level,
      slot: created.slot,
      isActive: created.isActive,
      itemCount: created._count.items,
    };
  }

  /**
   * Move a cell to another level and slot on the same shelf.
   *
   * A cell that holds goods can still be moved: the lot items keep pointing at it, so they
   * simply move with it. The new position must be free.
   */
  async updateCell(
    businessId: string,
    cellId: string,
    body: { level?: unknown; slot?: unknown },
  ): Promise<ShelfCellView> {
    const cell = await prisma.inventoryShelfCell.findFirst({
      where: { id: cellId, businessId },
      select: { id: true, shelfId: true, level: true, slot: true },
    });
    if (!cell) {
      throw new HttpError(404, "Khong tim thay o ke.");
    }

    const level = body.level === undefined ? cell.level : parsePosition(body.level, "Tang");
    const slot = body.slot === undefined ? cell.slot : parsePosition(body.slot, "O");

    if (level !== cell.level || slot !== cell.slot) {
      const clash = await prisma.inventoryShelfCell.findFirst({
        where: { shelfId: cell.shelfId, level, slot, id: { not: cellId } },
        select: { id: true },
      });
      if (clash) {
        throw new HttpError(409, `O ke tang ${level} - o ${slot} da ton tai tren ke nay.`);
      }
    }

    const updated = await prisma.inventoryShelfCell.update({
      where: { id: cellId },
      data: { level, slot },
      select: {
        id: true,
        level: true,
        slot: true,
        isActive: true,
        _count: { select: { items: true } },
      },
    });

    return {
      id: updated.id,
      level: updated.level,
      slot: updated.slot,
      isActive: updated.isActive,
      itemCount: updated._count.items,
    };
  }

  /**
   * Delete a cell (position) on a shelf.
   *
   * It is only deactivated: the lot items still point at it, so a hard delete would leave them
   * without a location. A deleted cell comes back when goods are put on it again.
   */
  async removeCell(businessId: string, cellId: string): Promise<void> {
    const cell = await prisma.inventoryShelfCell.findFirst({
      where: { id: cellId, businessId },
      select: { id: true },
    });
    if (!cell) {
      throw new HttpError(404, "Khong tim thay o ke.");
    }

    await prisma.inventoryShelfCell.update({
      where: { id: cellId },
      data: { isActive: false },
    });
  }

  /**
   * The cell of a shelf position, created when it does not exist yet.
   *
   * The staff pick a shelf, a level and a slot; they never type a cell id. So the cell is
   * created on demand, which keeps the shelf list short and the location always valid.
   */
  async assignCell(
    db: ShelfCellWriter,
    businessId: string,
    shelfId: string,
    level: number,
    slot: number,
  ): Promise<ShelfCellView> {
    const existing = await db.inventoryShelfCell.findFirst({
      where: { shelfId, level, slot },
      select: {
        id: true,
        level: true,
        slot: true,
        isActive: true,
        _count: { select: { items: true } },
      },
    });
    if (existing) {
      // A cell that was deleted comes back when goods are put on it again.
      if (!existing.isActive) {
        const revived = await db.inventoryShelfCell.update({
          where: { id: existing.id },
          data: { isActive: true },
          select: {
            id: true,
            level: true,
            slot: true,
            isActive: true,
            _count: { select: { items: true } },
          },
        });
        return {
          id: revived.id,
          level: revived.level,
          slot: revived.slot,
          isActive: revived.isActive,
          itemCount: revived._count.items,
        };
      }
      return {
        id: existing.id,
        level: existing.level,
        slot: existing.slot,
        isActive: existing.isActive,
        itemCount: existing._count.items,
      };
    }

    const created = await db.inventoryShelfCell.create({
      data: { businessId, shelfId, level, slot },
      select: {
        id: true,
        level: true,
        slot: true,
        isActive: true,
        _count: { select: { items: true } },
      },
    });

    return {
      id: created.id,
      level: created.level,
      slot: created.slot,
      isActive: created.isActive,
      itemCount: created._count.items,
    };
  }
}

export const shelfService = new ShelfService();
