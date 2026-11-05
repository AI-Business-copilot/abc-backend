import type { Request, Response } from "express";

import { inventoryService, auditService } from "./inventory.service";
import { LotService } from "./services/lot.service";
import { ScrapService } from "./services/scrap.service";
import { LotStatusService } from "./services/lot-status.service";

const fail = (res: Response, err: any) => {
  console.error(err);
  return res.status(err.status || err.statusCode || 500).json({ message: err.message || "Lỗi hệ thống" });
};

const authUserId = (req: Request) => String(req.identity?.id || "");

const lotService = new LotService(new LotStatusService());
const scrapService = new ScrapService();

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

  async getVariantLots(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const variantId = String(req.params.variantId || "");
      const result = await inventoryService.getLots(businessId, variantId);
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

  // F07: Stock Audit endpoints
  async createAudit(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await auditService.createAudit(businessId, authUserId(req), req.body ?? {});
      return res.status(201).json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async listAudits(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await auditService.listAudits(businessId, {
        status: String(req.query.status || ""),
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 10,
      });
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async getAudit(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await auditService.getAudit(businessId, String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async recordCount(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await auditService.recordCount(
        businessId,
        String(req.params.id),
        req.body ?? {},
      );
      return res.status(201).json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async updateCount(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await auditService.updateCount(
        businessId,
        String(req.params.id),
        String(req.params.itemId),
        req.body ?? {},
      );
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async getAuditItems(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await auditService.getAuditItems(businessId, String(req.params.id), {
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 20,
      });
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async approveAudit(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await auditService.approveAudit(businessId, authUserId(req), String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async applyAudit(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await auditService.applyAudit(businessId, authUserId(req), String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  // F08: Lot Tracking & Scrap Management endpoints

  async getLots(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await lotService.getLots(businessId, {
        status: String(req.query.status || "").toUpperCase() || undefined,
        variantId: String(req.query.variantId || "") || undefined,
        daysUntilMin: req.query.daysUntilMin ? Number(req.query.daysUntilMin) : undefined,
        daysUntilMax: req.query.daysUntilMax ? Number(req.query.daysUntilMax) : undefined,
        skip: Math.max(0, Number(req.query.skip) || 0),
        take: Math.min(100, Math.max(1, Number(req.query.take) || 20)),
      });
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async getExpiringLots(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await lotService.getExpiringLots(businessId, {
        status: (String(req.query.status || "").toUpperCase() as any) || undefined,
        skip: Math.max(0, Number(req.query.skip) || 0),
        take: Math.min(100, Math.max(1, Number(req.query.take) || 20)),
      });
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async getLot(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await lotService.getLot(businessId, String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async quarantineLot(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await lotService.quarantineLot(businessId, String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async createScrapOrder(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await scrapService.createScrapOrder(businessId, authUserId(req), req.body ?? {});
      return res.status(201).json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async getScrapOrders(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await scrapService.getScrapOrders(businessId, {
        status: String(req.query.status || "") || undefined,
        scrapSource: String(req.query.scrapSource || "") || undefined,
        startDate: req.query.startDate ? new Date(String(req.query.startDate)) : undefined,
        endDate: req.query.endDate ? new Date(String(req.query.endDate)) : undefined,
        skip: Math.max(0, Number(req.query.skip) || 0),
        take: Math.min(100, Math.max(1, Number(req.query.take) || 20)),
      });
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async getScrapOrder(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await scrapService.getScrapOrder(businessId, String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async updateScrapOrder(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await scrapService.updateScrapOrder(
        businessId,
        String(req.params.id),
        req.body ?? {},
      );
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async deleteScrapOrder(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      await scrapService.deleteScrapOrder(businessId, String(req.params.id));
      return res.status(204).send();
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async approveScrapOrder(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await scrapService.approveScrapOrder(
        businessId,
        String(req.params.id),
        authUserId(req),
      );
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async rejectScrapOrder(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await scrapService.rejectScrapOrder(
        businessId,
        String(req.params.id),
        req.body?.reason,
      );
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }
}
