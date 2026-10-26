// src/modules/products/controllers/product-variants.controller.ts
import { Request, Response } from "express";
import { VariantGeneratorService } from "../services/variant-generator.service";

const service = new VariantGeneratorService();

export class ProductVariantsController {
  async generate(req: Request, res: Response) {
    try {
      const { templateId } = req.params;
      const body = req.body;
      const businessId = String(res.locals.businessId || body.businessId || "");

      if (!businessId) {
        return res.status(401).json({ message: "Bạn cần đăng nhập để tạo biến thể" });
      }

      const result = await service.generate({
        businessId,
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