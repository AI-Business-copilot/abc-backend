import type { Request, Response } from "express";

import { CategoriesService } from "./categories.service";

const service = new CategoriesService();

export class CategoriesController {
  async list(_req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId ?? "");
      const result = await service.list(businessId);
      return res.json(result);
    } catch (err: any) {
      console.error(err);
      return res.status(err.status || 500).json({ message: err.message || "Loi he thong" });
    }
  }

  async create(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId ?? "");
      const result = await service.create(businessId, req.body ?? {});
      return res.status(201).json(result);
    } catch (err: any) {
      console.error(err);
      return res.status(err.status || 500).json({ message: err.message || "Loi he thong" });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId ?? "");
      const result = await service.update(businessId, String(req.params.id), req.body ?? {});
      return res.json(result);
    } catch (err: any) {
      console.error(err);
      return res.status(err.status || 500).json({ message: err.message || "Loi he thong" });
    }
  }

  async remove(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId ?? "");
      const result = await service.remove(businessId, String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      console.error(err);
      return res.status(err.status || 500).json({ message: err.message || "Loi he thong" });
    }
  }
}
