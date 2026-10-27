// src/modules/products/routes/products.routes.ts
import { Router } from "express";

import { requireBusinessScope } from "../../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../../shared/auth/supabase-auth.middleware";
import { AttributesController } from "../controllers/attributes.controller";
import { ProductListController } from "../controllers/product-list.controller";
import { ProductTemplatesController } from "../controllers/product-templates.controller";
import { ProductVariantsController } from "../controllers/product-variants.controller";

const router = Router();
const templatesCtrl = new ProductTemplatesController();
const attrsCtrl = new AttributesController();
const variantsCtrl = new ProductVariantsController();
const listCtrl = new ProductListController();

// Mọi endpoint sản phẩm đều phải đăng nhập và chỉ thao tác trên cửa hàng của chính mình.
router.use(requireSupabaseIdentity);
router.use(requireBusinessScope);

router.get("/list", requirePermission("products.read"), listCtrl.list.bind(listCtrl));

router.get("/templates", requirePermission("products.read"), templatesCtrl.list.bind(templatesCtrl));
router.post("/templates", requirePermission("products.manage"), templatesCtrl.create.bind(templatesCtrl));
router.get("/templates/:id", requirePermission("products.read"), templatesCtrl.getById.bind(templatesCtrl));
router.patch("/templates/:id", requirePermission("products.manage"), templatesCtrl.update.bind(templatesCtrl));

router.get("/attributes", requirePermission("products.read"), attrsCtrl.list.bind(attrsCtrl));
router.post("/attributes", requirePermission("products.manage"), attrsCtrl.create.bind(attrsCtrl));
router.post("/attributes/values", requirePermission("products.manage"), attrsCtrl.addValue.bind(attrsCtrl));
router.patch("/attributes/values/:id", requirePermission("products.manage"), attrsCtrl.updateValue.bind(attrsCtrl));
router.delete("/attributes/values/:id", requirePermission("products.manage"), attrsCtrl.removeValue.bind(attrsCtrl));
router.get("/attributes/:id", requirePermission("products.read"), attrsCtrl.getById.bind(attrsCtrl));
router.patch("/attributes/:id", requirePermission("products.manage"), attrsCtrl.update.bind(attrsCtrl));
router.delete("/attributes/:id", requirePermission("products.manage"), attrsCtrl.remove.bind(attrsCtrl));

router.post(
  "/templates/:templateId/variants/generate",
  requirePermission("products.manage"),
  variantsCtrl.generate.bind(variantsCtrl),
);
router.patch(
  "/templates/:templateId/variants/bulk",
  requirePermission("products.manage"),
  variantsCtrl.bulkUpdate.bind(variantsCtrl),
);

export default router;
