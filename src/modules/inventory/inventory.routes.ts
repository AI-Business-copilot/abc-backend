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

// F07: Stock Audit endpoints
router.post("/audits", requirePermission("inventory.audit.create"), controller.createAudit.bind(controller));
router.get("/audits", requirePermission("inventory.read"), controller.listAudits.bind(controller));
router.get("/audits/:id", requirePermission("inventory.read"), controller.getAudit.bind(controller));

// Owner: add employee + variant + optional lot rows, and reassign an item to another employee
router.post("/audits/:id/items/assign", requirePermission("inventory.audit.create"), controller.addAuditItems.bind(controller));
router.patch("/audits/:id/items/:itemId/assign", requirePermission("inventory.audit.create"), controller.reassignAuditItem.bind(controller));

router.post("/audits/:id/items", requirePermission("inventory.audit.count"), controller.recordCount.bind(controller));
router.patch("/audits/:id/items/:itemId", requirePermission("inventory.audit.count"), controller.updateCount.bind(controller));
router.get("/audits/:id/items", requirePermission("inventory.read"), controller.getAuditItems.bind(controller));
router.get("/audits/:id/items/:itemId", requirePermission("inventory.read"), controller.getAuditItem.bind(controller));

// F07: Item-level submission and approval (new per-item workflow)
router.post("/audits/:id/items/:itemId/submit", requirePermission("inventory.audit.submit_item"), controller.submitAuditItem.bind(controller));
router.patch("/audits/:id/items/:itemId/approve", requirePermission("inventory.audit.approve_item"), controller.approveAuditItem.bind(controller));
router.patch("/audits/:id/items/:itemId/reject", requirePermission("inventory.audit.approve_item"), controller.rejectAuditItem.bind(controller));

router.patch("/audits/:id/approve", requirePermission("inventory.audit.approve"), controller.approveAudit.bind(controller));
router.patch("/audits/:id/apply", requirePermission("inventory.audit.apply"), controller.applyAudit.bind(controller));

// F08: Lot Tracking & Scrap Management endpoints
router.get("/lots/expiring", requirePermission("inventory.lot.read"), controller.getExpiringLots.bind(controller));
router.get("/lots/:id", requirePermission("inventory.lot.read"), controller.getLot.bind(controller));
router.post("/lots/:id/quarantine", requirePermission("inventory.scrap.create"), controller.quarantineLot.bind(controller));

router.post("/scrap-orders", requirePermission("inventory.scrap.create"), controller.createScrapOrder.bind(controller));
router.get("/scrap-orders", requirePermission("inventory.lot.read"), controller.getScrapOrders.bind(controller));
router.get("/scrap-orders/:id", requirePermission("inventory.lot.read"), controller.getScrapOrder.bind(controller));
router.patch("/scrap-orders/:id", requirePermission("inventory.scrap.create"), controller.updateScrapOrder.bind(controller));
router.delete("/scrap-orders/:id", requirePermission("inventory.scrap.create"), controller.deleteScrapOrder.bind(controller));
router.patch("/scrap-orders/:id/approve", requirePermission("inventory.scrap.approve"), controller.approveScrapOrder.bind(controller));
router.patch("/scrap-orders/:id/reject", requirePermission("inventory.scrap.approve"), controller.rejectScrapOrder.bind(controller));

export default router;
