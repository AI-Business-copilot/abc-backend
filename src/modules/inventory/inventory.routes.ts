import { Router } from "express";

import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { InventoryController } from "./inventory.controller";

const router = Router();
const controller = new InventoryController();

router.use(requireSupabaseIdentity);
router.use(requireBusinessScope);

router.get("/opening-sheets", requirePermission("inventory.read"), controller.listSheets.bind(controller));
router.get("/opening-sheets/next-code", requirePermission("inventory.read"), controller.nextCode.bind(controller));
router.get("/opening-sheets/:id", requirePermission("inventory.read"), controller.getSheet.bind(controller));
router.post("/opening-sheets", requirePermission("inventory.receive"), controller.createSheet.bind(controller));
router.patch("/opening-sheets/:id", requirePermission("inventory.receive"), controller.updateSheet.bind(controller));
router.post("/opening-sheets/:id/apply", requirePermission("inventory.receive"), controller.applySheet.bind(controller));
router.delete("/opening-sheets/:id", requirePermission("inventory.receive"), controller.removeSheet.bind(controller));

router.get("/variants", requirePermission("inventory.read"), controller.variants.bind(controller));
router.get("/lots", requirePermission("inventory.read"), controller.lots.bind(controller));
router.get("/ledger", requirePermission("inventory.read"), controller.ledger.bind(controller));

export default router;
