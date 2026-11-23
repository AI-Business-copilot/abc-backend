import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { HttpError } from "../../shared/http/http-error";
import { confirmSupplierImport, previewSupplierImport } from "./supplier-import.service";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2, fieldSize: 4096 } }).single("file");
function workbook(req: Request, res: Response, next: NextFunction) {
  upload(req, res, error => {
    if (error) return next(error instanceof multer.MulterError ? new HttpError(400, "Chọn một file tối đa 5 MB.") : error);
    if (!req.file || !/\.(xlsx|csv)$/i.test(req.file.originalname)) return next(new HttpError(400, "Chọn file Excel .xlsx hoặc CSV UTF-8."));
    next();
  });
}
function mapping(req: Request): unknown {
  if (req.body.mapping === undefined) return undefined;
  try { return JSON.parse(req.body.mapping); } catch { throw new HttpError(400, "Ánh xạ cột không hợp lệ."); }
}
router.post("/suppliers/:id/products/import/preview", requirePermission("inventory.receive"), requirePermission("products.manage"), workbook, async (req, res) => {
  res.json(await previewSupplierImport(String(res.locals.businessId), String(req.params.id), req.file!, mapping(req)));
});
router.post("/suppliers/:id/products/import/confirm", requirePermission("inventory.receive"), requirePermission("products.manage"), workbook, async (req, res) => {
  res.json(await confirmSupplierImport(String(res.locals.businessId), String(req.params.id), req.file!, mapping(req), req.body.digest));
});
export default router;
