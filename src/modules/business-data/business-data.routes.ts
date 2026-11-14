import { Router } from "express";

import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { businessDataService } from "./business-data.service";

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
