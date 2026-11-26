import { Router } from "express";

import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { businessDataService } from "./business-data.service";
import { getBusinessMovement } from "./business-movement.service";
import { getProductPerformance } from "./product-performance.service";
import { getSimulationBasis, searchSimulationVariants, simulateProfit } from "./profit-simulation.service";

const router = Router();
router.use(requireSupabaseIdentity, requireBusinessScope);

router.post(
  "/pos/aggregate",
  requirePermission("business_data.manage"),
  async (req, res) => {
    res.json(
      await businessDataService.rebuildPosMetrics(
        String(res.locals.businessId),
        req.body?.from,
        req.body?.to,
      ),
    );
  },
);

router.get(
  "/profit-simulation/variants",
  requirePermission("analytics.read"),
  requirePermission("finance.read"),
  async (req, res) => {
    res.json(await searchSimulationVariants(String(res.locals.businessId), req.query));
  },
);

router.get(
  "/profit-simulation/basis",
  requirePermission("analytics.read"),
  requirePermission("finance.read"),
  async (req, res) => {
    res.json(await getSimulationBasis(String(res.locals.businessId), req.query));
  },
);

router.post(
  "/profit-simulation/calculate",
  requirePermission("analytics.read"),
  requirePermission("finance.read"),
  async (req, res) => {
    res.json(await simulateProfit(String(res.locals.businessId), req.body));
  },
);

router.get(
  "/business-movement",
  requirePermission("analytics.read"),
  requirePermission("finance.read"),
  async (req, res) => {
    res.json(await getBusinessMovement(String(res.locals.businessId), req.query));
  },
);

router.get(
  "/product-performance",
  requirePermission("analytics.read"),
  requirePermission("finance.read"),
  async (req, res) => {
    res.json(await getProductPerformance(String(res.locals.businessId), req.query));
  },
);

router.get(
  "/ai-ready",
  requirePermission("analytics.read"),
  requirePermission("finance.read"),
  async (req, res) => {
    res.json(
      await businessDataService.getAiReadyData(
        String(res.locals.businessId),
        req.query.from,
        req.query.to,
      ),
    );
  },
);

export default router;
