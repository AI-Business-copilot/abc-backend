import { Request, Response } from 'express';
import { AttributesService } from '../services/attributes.service';

const service = new AttributesService();

export class AttributesController {
  async create(req: Request, res: Response) {
    try {
      const result = await service.create(req.body);
      return res.status(201).json(result);
    } catch (err: any) {
      console.error(err);
      return res.status(err.status || 500).json({ message: err.message || 'Loi he thong' });
    }
  }

  async addValue(req: Request, res: Response) {
    try {
      const result = await service.addValue(req.body);
      return res.status(201).json(result);
    } catch (err: any) {
      console.error(err);
      return res.status(err.status || 500).json({ message: err.message || 'Loi he thong' });
    }
  }

  async list(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || req.query.businessId || '');
      const result = await service.list(businessId);
      return res.json(result);
    } catch (err: any) {
      console.error(err);
      return res.status(err.status || 500).json({ message: err.message || 'Loi he thong' });
    }
  }
}

