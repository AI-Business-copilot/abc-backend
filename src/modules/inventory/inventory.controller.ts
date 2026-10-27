import type { Request, Response } from "express";

import { inventoryService } from "./inventory.service";

const fail = (res: Response, err: any) => {
  console.error(err);
  return res.status(err.status || err.statusCode || 500).json({ message: err.message || "Lỗi hệ thống" });
};

const authUserId = (req: Request) => String(req.identity?.id || "");

export class InventoryController {
  async listSheets(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await inventoryService.listSheets(businessId, {
        search: String(req.query.search || ""),
        status: String(req.query.status || ""),
        month: String(req.query.month || ""),
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 5,
      });
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async getSheet(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 3));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const result = await inventoryService.getSheet(businessId, String(req.params.id), limit, offset);
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async nextCode(_req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      return res.json(await inventoryService.getNextCode(businessId));
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async createSheet(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await inventoryService.createSheet(businessId, authUserId(req), req.body ?? {});
      return res.status(201).json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async updateSheet(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await inventoryService.updateSheet(
        businessId,
        authUserId(req),
        String(req.params.id),
        req.body ?? {},
      );
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async applySheet(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await inventoryService.applySheet(businessId, authUserId(req), String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async removeSheet(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await inventoryService.removeSheet(businessId, String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async variants(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await inventoryService.searchVariants(businessId, {
        search: String(req.query.search || ""),
        categoryId: String(req.query.categoryId || ""),
        limit: Number(req.query.limit) || 20,
      });
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async lots(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await inventoryService.getLots(businessId, String(req.query.variantId || ""));
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async ledger(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await inventoryService.ledger(businessId, {
        search: String(req.query.search || ""),
        type: String(req.query.type || ""),
        from: String(req.query.from || ""),
        to: String(req.query.to || ""),
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 20,
      });
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }
}
