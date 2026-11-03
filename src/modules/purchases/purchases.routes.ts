import { Router, type Request, type Response } from "express";

import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { purchasesService } from "./purchases.service";
import { purchasesWriteService } from "./purchases-write.service";
import { purchasesLifecycleService } from "./purchases-lifecycle.service";
import { purchasesCorrectionService } from "./purchases-correction.service";
import { purchasesPaymentsService } from "./purchases-payments.service";
import { purchasesDraftsService } from "./purchases-drafts.service";

const router = Router();
router.use(requireSupabaseIdentity, requireBusinessScope, requirePermission("inventory.read"));
// These responses contain purchase costs, payments and supplier debt.
router.use(requirePermission("finance.read"));

router.get("/orders", async (req: Request, res: Response) => {
  res.json(await purchasesService.listOrders(String(res.locals.businessId), req.query));
});
router.get("/orders/:id", async (req: Request, res: Response) => {
  res.json(await purchasesService.getOrder(String(res.locals.businessId), String(req.params.id)));
});
router.get("/receipts", async (req: Request, res: Response) => {
  res.json(await purchasesService.listReceipts(String(res.locals.businessId), req.query));
});
router.get("/receipts/:id", async (req: Request, res: Response) => {
  res.json(await purchasesService.getReceipt(String(res.locals.businessId), String(req.params.id)));
});
router.get("/suppliers", async (req: Request, res: Response) => {
  res.json(await purchasesService.listSuppliers(String(res.locals.businessId), req.query));
});

router.post("/suppliers", requirePermission("inventory.receive"), async (req: Request, res: Response) => {
  res.status(201).json(await purchasesWriteService.createSupplier(String(res.locals.businessId), req.body));
});
router.post("/orders", requirePermission("inventory.receive"), async (req: Request, res: Response) => {
  res.status(201).json(await purchasesWriteService.createOrder(String(res.locals.businessId), req.identity!.id, req.body));
});
router.post("/orders/:id/receipts", requirePermission("inventory.receive"), async (req: Request, res: Response) => {
  res.status(201).json(await purchasesWriteService.receiveOrder(String(res.locals.businessId), req.identity!.id, String(req.params.id), req.body));
});
router.patch("/receipts/:id/payment", requirePermission("inventory.receive"), async (req: Request, res: Response) => {
  res.json(await purchasesWriteService.updatePayment(String(res.locals.businessId), req.identity!.id, String(req.params.id), req.body));
});

router.patch("/orders/:id", requirePermission("inventory.receive"), async (req: Request, res: Response) => {
  res.json(await purchasesLifecycleService.updateOrder(String(res.locals.businessId), req.identity!.id, String(req.params.id), req.body));
});
router.post("/orders/:id/cancel", requirePermission("inventory.receive"), async (req: Request, res: Response) => {
  res.json(await purchasesLifecycleService.finishOrder(String(res.locals.businessId), req.identity!.id, String(req.params.id), "cancel"));
});
router.post("/orders/:id/close", requirePermission("inventory.receive"), async (req: Request, res: Response) => {
  res.json(await purchasesLifecycleService.finishOrder(String(res.locals.businessId), req.identity!.id, String(req.params.id), "close"));
});
router.get("/suppliers/:id/debt-reconciliation", async (req: Request, res: Response) => {
  res.json(await purchasesLifecycleService.reconcileDebt(String(res.locals.businessId), req.identity!.id, String(req.params.id)));
});
router.post("/suppliers/:id/debt-reconciliation", requirePermission("inventory.receive"), async (req: Request, res: Response) => {
  res.json(await purchasesLifecycleService.reconcileDebt(String(res.locals.businessId), req.identity!.id, String(req.params.id), req.body));
});
router.patch("/receipts/:id/items", requirePermission("inventory.receive"), requirePermission("inventory.adjust"), async (req: Request, res: Response) => {
  res.json(await purchasesCorrectionService.correctReceipt(String(res.locals.businessId), req.identity!.id, String(req.params.id), req.body));
});
router.post("/cash-shifts", requirePermission("inventory.receive"), async (req: Request, res: Response) => {
  res.json(await purchasesPaymentsService.openShift(String(res.locals.businessId), req.identity!.id, req.body ?? {}));
});
router.get("/cash-shifts/current", async (req: Request, res: Response) => {
  res.json(await purchasesPaymentsService.getOpenShift(String(res.locals.businessId), req.identity!.id));
});
router.get("/receipts/:id/payments", async (req: Request, res: Response) => {
  res.json(await purchasesPaymentsService.history(String(res.locals.businessId), String(req.params.id)));
});
router.post("/orders/:id/receipt-drafts", requirePermission("inventory.receive"), async (req: Request, res: Response) => {
  res.status(201).json(await purchasesDraftsService.preview(String(res.locals.businessId), req.identity!.id, String(req.params.id), req.body));
});
router.post("/orders/:id/receipt-drafts/confirm", requirePermission("inventory.receive"), async (req: Request, res: Response) => {
  res.status(201).json(await purchasesDraftsService.confirm(String(res.locals.businessId), req.identity!.id, String(req.params.id), req.body));
});

export default router;
