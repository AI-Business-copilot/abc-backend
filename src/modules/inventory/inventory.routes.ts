import { Router } from "express";

import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { requireMultipart, uploadImages, uploadImagesIfMultipart } from "../../shared/http/upload.middleware";
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
router.put("/opening-sheets/:id", requirePermission("inventory.receive"), controller.updateSheet.bind(controller));
router.post("/opening-sheets/:id/apply", requirePermission("inventory.receive"), controller.applySheet.bind(controller));
router.delete("/opening-sheets/:id", requirePermission("inventory.receive"), controller.removeSheet.bind(controller));

router.get("/variants", requirePermission("inventory.read"), controller.variants.bind(controller));
router.get("/variants/:variantId/lots", requirePermission("inventory.read"), controller.getVariantLots.bind(controller));
router.get("/lots", requirePermission("inventory.read"), controller.lots.bind(controller));
router.get("/ledger", requirePermission("inventory.read"), controller.ledger.bind(controller));

// F07: Stock Audit endpoints
router.post("/audits", requirePermission("inventory.audit.create"), controller.createAudit.bind(controller));
router.get("/audits", requirePermission("inventory.read"), controller.listAudits.bind(controller));
router.get("/audits/:id", requirePermission("inventory.read"), controller.getAudit.bind(controller));

// Owner: the lifecycle of an audit. A draft can be deleted, a running audit can only be cancelled.
router.patch("/audits/:id/start", requirePermission("inventory.audit.create"), controller.startAudit.bind(controller));
router.patch("/audits/:id/cancel", requirePermission("inventory.audit.create"), controller.cancelAudit.bind(controller));
router.delete("/audits/:id", requirePermission("inventory.audit.create"), controller.deleteAudit.bind(controller));
router.delete("/audits/:id/items/:itemId", requirePermission("inventory.audit.create"), controller.deleteAuditItem.bind(controller));

// Owner: add employee + variant + lot rows, and reassign an item to another employee
router.post("/audits/:id/items/assign", requirePermission("inventory.audit.create"), controller.addAuditItems.bind(controller));
router.patch("/audits/:id/items/:itemId/assign", requirePermission("inventory.audit.create"), controller.reassignAuditItem.bind(controller));

router.post("/audits/:id/items", requirePermission("inventory.audit.count"), controller.recordCount.bind(controller));
// The count can carry evidence photos of the broken goods, so the body may be multipart.
router.patch(
  "/audits/:id/items/:itemId",
  requirePermission("inventory.audit.count"),
  uploadImagesIfMultipart,
  controller.updateCount.bind(controller),
);
router.get("/audits/:id/items", requirePermission("inventory.read"), controller.getAuditItems.bind(controller));
router.get("/audits/:id/items/:itemId", requirePermission("inventory.read"), controller.getAuditItem.bind(controller));
// F07: the history of one row. Only the owner reads it; the service refuses everyone else.
router.get("/audits/:id/items/:itemId/history", requirePermission("inventory.read"), controller.getAuditItemHistory.bind(controller));

// F07: evidence photos of one counter's count. View only; they are written with the count.
router.get(
  "/audits/:id/items/:itemId/counts/:countId/images",
  requirePermission("inventory.read"),
  controller.listAuditCountImages.bind(controller),
);
router.get(
  "/audit-count-images/:imageId",
  requirePermission("inventory.read"),
  controller.getAuditCountImage.bind(controller),
);

// F07: Item-level submission and approval (new per-item workflow)
router.post("/audits/:id/items/:itemId/submit", requirePermission("inventory.audit.submit_item"), controller.submitAuditItem.bind(controller));
router.patch("/audits/:id/items/:itemId/approve", requirePermission("inventory.audit.approve_item"), controller.approveAuditItem.bind(controller));
router.patch("/audits/:id/items/:itemId/reject", requirePermission("inventory.audit.approve_item"), controller.rejectAuditItem.bind(controller));
// Owner: the two counters disagree, so the row goes back to both of them for another count.
router.patch("/audits/:id/items/:itemId/recount", requirePermission("inventory.audit.approve_item"), controller.requestRecount.bind(controller));

router.patch("/audits/:id/approve", requirePermission("inventory.audit.approve"), controller.approveAudit.bind(controller));
router.patch("/audits/:id/apply", requirePermission("inventory.audit.apply"), controller.applyAudit.bind(controller));

// F08: Lot Tracking & Scrap Management endpoints
router.get("/lots/expiring", requirePermission("inventory.lot.read"), controller.getExpiringLots.bind(controller));
router.get("/lots/:id", requirePermission("inventory.lot.read"), controller.getLot.bind(controller));
router.post("/lots/:lotId/items/:itemId/quarantine", requirePermission("inventory.scrap.create"), controller.quarantineLot.bind(controller));

// F08: a product with no lot item keeps its quarantine on the variant.
router.get("/variants/:variantId/quarantine", requirePermission("inventory.lot.read"), controller.getVariantQuarantine.bind(controller));
router.post("/variants/:variantId/quarantine", requirePermission("inventory.scrap.create"), controller.quarantineVariant.bind(controller));

router.post(
  "/scrap-orders",
  requirePermission("inventory.scrap.create"),
  requireMultipart,
  uploadImages,
  controller.createScrapOrder.bind(controller),
);
router.get("/scrap-orders", requirePermission("inventory.lot.read"), controller.getScrapOrders.bind(controller));
router.get("/scrap-orders/:id", requirePermission("inventory.lot.read"), controller.getScrapOrder.bind(controller));
router.patch("/scrap-orders/:id", requirePermission("inventory.scrap.create"), controller.updateScrapOrder.bind(controller));
router.delete("/scrap-orders/:id", requirePermission("inventory.scrap.create"), controller.deleteScrapOrder.bind(controller));
router.patch("/scrap-orders/:id/approve", requirePermission("inventory.scrap.approve"), controller.approveScrapOrder.bind(controller));
router.patch("/scrap-orders/:id/reject", requirePermission("inventory.scrap.approve"), controller.rejectScrapOrder.bind(controller));
router.patch("/scrap-orders/:id/cancel", requirePermission("inventory.scrap.approve"), controller.cancelScrapOrder.bind(controller));
router.get("/scrap-statistics", requirePermission("inventory.lot.read"), controller.getScrapStatistics.bind(controller));

// F08: the disposal dossier for the tax file (Thông tư 78/2014, amended by Thông tư 96/2015).
router.patch("/scrap-orders/:id/dossier", requirePermission("inventory.scrap.create"), controller.recordScrapDossier.bind(controller));
router.patch("/scrap-orders/:id/confirm-disposal", requirePermission("inventory.scrap.approve"), controller.confirmScrapDisposal.bind(controller));
router.get("/scrap-orders/:id/dossier-report", requirePermission("inventory.lot.read"), controller.getScrapDossierReport.bind(controller));

// F08: scrap order evidence images. View only; images are created with the scrap order and cannot be changed afterward.
router.get("/scrap-orders/:id/images", requirePermission("inventory.lot.read"), controller.listScrapImages.bind(controller));
router.get("/scrap-order-images/:imageId", requirePermission("inventory.lot.read"), controller.getScrapImage.bind(controller));

export default router;
