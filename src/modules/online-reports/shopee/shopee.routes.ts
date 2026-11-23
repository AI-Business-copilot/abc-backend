import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";

import { requireBusinessScope } from "../../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../../shared/auth/supabase-auth.middleware";
import { HttpError } from "../../../shared/http/http-error";
import { shopeeReportService } from "./shopee-report.service";

const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_WORKBOOK_BYTES, files: 1, fields: 5, fieldSize: 2_000 },
}).single("file");

function requireShopeeWorkbook(req: Request, res: Response, next: NextFunction): void {
  upload(req, res, (error?: unknown) => {
    if (error instanceof multer.MulterError) {
      next(new HttpError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, "Upload one Shopee .xlsx workbook up to 10 MB."));
      return;
    }
    if (error) {
      next(error);
      return;
    }
    if (!req.file) {
      next(new HttpError(400, "Choose an .xlsx workbook in the 'file' field."));
      return;
    }
    if (!req.file.originalname.toLocaleLowerCase("en-US").endsWith(".xlsx")) {
      next(new HttpError(415, "Only .xlsx workbooks are supported."));
      return;
    }
    if (req.file.buffer.length < 4 || req.file.buffer[0] !== 0x50 || req.file.buffer[1] !== 0x4b) {
      next(new HttpError(415, "The uploaded file is not an XLSX workbook."));
      return;
    }
    next();
  });
}

const router = Router();
router.use(requireSupabaseIdentity, requireBusinessScope);

router.post(
  "/preview",
  requirePermission("business_data.manage"),
  requirePermission("finance.read"),
  requireShopeeWorkbook,
  async (req, res) => {
    res.json(await shopeeReportService.previewReport(String(res.locals.businessId), req.file!.buffer));
  },
);

router.post(
  "/import",
  requirePermission("business_data.manage"),
  requirePermission("finance.read"),
  requireShopeeWorkbook,
  async (req, res) => {
    res.status(201).json(
      await shopeeReportService.importReport(
        String(res.locals.businessId),
        String(res.locals.userId),
        req.file!.buffer,
      ),
    );
  },
);

router.get(
  "/imports",
  requirePermission("analytics.read"),
  requirePermission("finance.read"),
  async (_req, res) => {
    res.json(await shopeeReportService.listImports(String(res.locals.businessId)));
  },
);

router.get(
  "/records",
  requirePermission("analytics.read"),
  requirePermission("finance.read"),
  async (req, res) => {
    res.json(
      await shopeeReportService.getFinancialRecords(
        String(res.locals.businessId),
        req.query.from,
        req.query.to,
      ),
    );
  },
);

export default router;
