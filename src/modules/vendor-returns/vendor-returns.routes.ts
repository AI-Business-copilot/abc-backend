import { Router } from "express";
import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { vendorReturnsController } from "./vendor-returns.controller";

const router = Router();

router.use(requireSupabaseIdentity);
router.use(requireBusinessScope);

router.get("/", vendorReturnsController.listReturns.bind(vendorReturnsController));
router.get("/:id", vendorReturnsController.getReturn.bind(vendorReturnsController));
router.post("/", vendorReturnsController.createReturn.bind(vendorReturnsController));

export default router;
