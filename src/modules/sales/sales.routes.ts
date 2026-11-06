import { Router } from "express";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { purchasesPaymentsService } from "../purchases/purchases-payments.service";
import { salesService } from "./sales.service";

const router = Router();
router.use(requireSupabaseIdentity, requireBusinessScope, requirePermission("orders.read"));
router.get("/customers", async (req, res) => { res.json(await salesService.list(String(res.locals.businessId), req.query, true)); });
router.post("/customers", requirePermission("orders.create"), async (req, res) => { res.status(201).json(await salesService.createCustomer(String(res.locals.businessId), req.body)); });
router.get("/cash-shifts/current", async (req, res) => { res.json(await purchasesPaymentsService.getOpenShift(String(res.locals.businessId), req.identity!.id)); });
router.post("/cash-shifts", requirePermission("orders.create"), async (req, res) => { res.json(await purchasesPaymentsService.openShift(String(res.locals.businessId), req.identity!.id, req.body ?? {})); });
router.get("/orders", async (req, res) => { res.json(await salesService.list(String(res.locals.businessId), req.query)); });
router.get("/orders/:id", async (req, res) => { res.json(await salesService.get(String(res.locals.businessId), String(req.params.id))); });
router.post("/orders", requirePermission("orders.create"), async (req, res) => { res.status(201).json(await salesService.create(String(res.locals.businessId), req.identity!.id, req.body)); });
router.post("/orders/:id/payments", requirePermission("orders.create"), async (req, res) => { res.json(await salesService.complete(String(res.locals.businessId), req.identity!.id, String(req.params.id), req.body)); });
router.post("/orders/:id/cancel", requirePermission("orders.create"), async (req, res) => { res.json(await salesService.cancel(String(res.locals.businessId), req.identity!.id, String(req.params.id))); });
export default router;
