import { Request, Response } from 'express';
import { ProductTemplatesService } from '../services/product-templates.service';

const service = new ProductTemplatesService();

export class ProductTemplatesController {
  async create(req: Request, res: Response) {
    try {
      const result = await service.create(req.body);
      return res.status(201).json(result);
    } catch (err: any) {
      console.error(err);
      return res.status(err.status || 500).json({ message: err.message || 'Loi he thong' });
    }
  }

  async list(req: Request, res: Response) {
    try {
      const businessId = req.query.businessId as string;
      const result = await service.list(businessId);
      return res.json(result);
    } catch (err: any) {
      console.error(err);
      return res.status(err.status || 500).json({ message: err.message || 'Loi he thong' });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const result = await service.getById(String(req.params.id));
      return res.json(result);
    } catch (err: any) {
      console.error(err);
      return res.status(err.status || 500).json({ message: err.message || 'Loi he thong' });
    }
  }
}

