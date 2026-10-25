// src/modules/products/controllers/product-variants.controller.ts
import { Request, Response } from "express";
import { VariantGeneratorService } from "../services/variant-generator.service";

const service = new VariantGeneratorService();

export class ProductVariantsController {
  async generate(req: Request, res: Response) {
    try {
      const { templateId } = req.params;
      const body = req.body;

      if (!body.businessId) {
        return res.status(400).json({ message: "Thiếu businessId" });
      }

      const result = await service.generate({
        businessId: body.businessId,
        templateId: templateId as string,
        attributes: body.attributes,
        defaults: body.defaults,
        barcodeType: body.barcodeType,
      });

      return res.status(201).json({
        message: "Sinh biến thể thành công",
        ...result,
      });
    } catch (err: any) {
      console.error(err);
      return res.status(err.status || 500).json({
        message: err.message || "Lỗi hệ thống",
      });
    }
  }
}