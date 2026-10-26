import { Router } from "express";

import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { CategoriesController } from "./categories.controller";

const router = Router();
const controller = new CategoriesController();

router.use(requireSupabaseIdentity);
router.use(requireBusinessScope);

router.get("/", requirePermission("products.read"), controller.list.bind(controller));
router.post("/", requirePermission("products.manage"), controller.create.bind(controller));
router.patch("/:id", requirePermission("products.manage"), controller.update.bind(controller));
router.delete("/:id", requirePermission("products.manage"), controller.remove.bind(controller));

export default router;
