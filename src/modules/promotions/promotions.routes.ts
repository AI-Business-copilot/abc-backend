import { Router } from "express";

import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { promotionsService } from "./promotions.service";

const router = Router();

router.use(requireSupabaseIdentity, requireBusinessScope, requirePermission("promotions.manage"));
router.get("/options", async (_req, res) => {
  res.json(await promotionsService.options(String(res.locals.businessId)));
});
router.get("/", async (_req, res) => {
  res.json(await promotionsService.list(String(res.locals.businessId)));
});
router.post("/", async (req, res) => {
  res.status(201).json(await promotionsService.create(String(res.locals.businessId), req.identity!.id, req.body));
});
router.patch("/:id/status", async (req, res) => {
  res.json(await promotionsService.setStatus(String(res.locals.businessId), String(req.params.id), req.body));
});
router.patch("/:id", async (req, res) => {
  res.json(await promotionsService.update(String(res.locals.businessId), String(req.params.id), req.body));
});

export default router;
