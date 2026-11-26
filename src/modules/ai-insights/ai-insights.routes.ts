import { Router } from "express";

import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { aiInsightsService } from "./ai-insights.service";
import { replenishmentService } from "../ai-forecast/replenishment.service";
import { forecastHistory } from "../ai-forecast/forecast-history.service";
import { inventoryOutlook } from "./inventory-outlook.service";

const router = Router();
router.use(requireSupabaseIdentity, requireBusinessScope);

const businessId = (locals: Record<string, unknown>) => String(locals.businessId);

router.get("/summary", requirePermission("analytics.read"), async (_req, res) => {
  res.json(await aiInsightsService.summary(businessId(res.locals)));
});

router.get("/inventory-outlook", requirePermission("analytics.read"), async (req, res) => {
  res.json(await inventoryOutlook(businessId(res.locals), req.query));
});

router.get("/settings", requirePermission("analytics.read"), async (_req, res) => {
  res.json(await aiInsightsService.getSettings(businessId(res.locals)));
});

router.put("/settings", requirePermission("ai_insights.manage"), async (req, res) => {
  res.json(await aiInsightsService.updateSettings(businessId(res.locals), String(res.locals.userId), req.body));
});

router.post("/run", requirePermission("ai_insights.manage"), async (_req, res) => {
  res.json(await aiInsightsService.run(businessId(res.locals), "MANUAL", String(res.locals.userId)));
});

router.get("/replenishment", requirePermission("analytics.read"), async (req, res) => {
  res.json(await replenishmentService.list(businessId(res.locals), req.query));
});

router.post("/replenishment/draft-orders", requirePermission("ai_insights.manage"), requirePermission("inventory.receive"), async (req, res) => {
  res
    .status(201)
    .json(
      await replenishmentService.createDraftOrders(
        businessId(res.locals),
        req.identity!.id,
        String(res.locals.userId),
        req.body ?? {},
      ),
    );
});

router.patch("/replenishment/:id", requirePermission("ai_insights.manage"), async (req, res) => {
  res.json(
    await replenishmentService.setStatus(businessId(res.locals), String(req.params.id), String(res.locals.userId), req.body ?? {}),
  );
});

router.get("/forecasts/:variantId", requirePermission("analytics.read"), async (req, res) => {
  res.json(await replenishmentService.forecastDetail(businessId(res.locals), String(req.params.variantId)));
});

router.get("/forecasts/:variantId/history", requirePermission("analytics.read"), async (req, res) => {
  res.json(await forecastHistory(businessId(res.locals), String(req.params.variantId)));
});

router.get("/", requirePermission("analytics.read"), async (req, res) => {
  res.json(await aiInsightsService.list(businessId(res.locals), req.query));
});

router.get("/:id", requirePermission("analytics.read"), async (req, res) => {
  res.json(await aiInsightsService.get(businessId(res.locals), String(req.params.id)));
});

router.patch("/:id", requirePermission("ai_insights.manage"), async (req, res) => {
  res.json(
    await aiInsightsService.updateInsight(
      businessId(res.locals),
      String(req.params.id),
      String(res.locals.userId),
      req.body ?? {},
    ),
  );
});

export default router;
