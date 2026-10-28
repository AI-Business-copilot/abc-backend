import { Router } from "express";
import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { customerReturnsController } from "./customer-returns.controller";

const router = Router();

router.use(requireSupabaseIdentity);
router.use(requireBusinessScope);

router.get("/", customerReturnsController.listReturns.bind(customerReturnsController));
router.get("/lookup/:orderCode", customerReturnsController.lookupOrder.bind(customerReturnsController));
router.get("/:id", customerReturnsController.getReturn.bind(customerReturnsController));
router.post("/", customerReturnsController.createReturn.bind(customerReturnsController));

export default router;
