import { Request, Response } from "express";
import { ProductTemplatesService } from "../services/product-templates.service";

const service = new ProductTemplatesService();

const fail = (res: Response, err: any) => {
  console.error(err);
  return res.status(err.status || err.statusCode || 500).json({ message: err.message || "Loi he thong" });
};

export class ProductTemplatesController {
  async create(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await service.create(businessId, req.body ?? {});
      return res.status(201).json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async update(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await service.update(businessId, String(req.params.id), req.body ?? {});
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async list(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await service.list(businessId);
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await service.getById(businessId, String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async delete(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await service.delete(businessId, String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }
}
