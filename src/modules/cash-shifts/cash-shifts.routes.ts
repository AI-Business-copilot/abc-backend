import { Router } from "express";

import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { CashShiftsController } from "./cash-shifts.controller";

const router = Router();
const controller = new CashShiftsController();

router.use(requireSupabaseIdentity);
router.use(requireBusinessScope);

router.get("/", requirePermission("cash.shift.read"), controller.summary.bind(controller));
router.get("/reviews", requirePermission("cash.shift.review"), requirePermission("cash.shift.reconcile"), controller.reviewQueue.bind(controller));
router.post("/handoffs/preview", requirePermission("cash.shift.manage"), controller.previewHandoff.bind(controller));
router.post("/reviews/:reviewId/decision", requirePermission("cash.shift.review"), requirePermission("cash.shift.reconcile"), controller.decideCloseReview.bind(controller));
router.post("/handoff-reviews/:reviewId/decision", requirePermission("cash.shift.review"), requirePermission("cash.shift.reconcile"), controller.decideHandoffReview.bind(controller));
router.post("/handoffs/:id/explanation", requirePermission("cash.shift.manage"), controller.resubmitHandoffExplanation.bind(controller));
router.post("/", requirePermission("cash.shift.manage"), controller.openShift.bind(controller));
router.post("/:id/close/preview", requirePermission("cash.shift.manage"), controller.previewClose.bind(controller));
router.post("/:id/transactions", requirePermission("cash.shift.manage"), controller.recordTransaction.bind(controller));
router.post("/:id/withdrawals", requirePermission("cash.shift.withdraw"), controller.withdraw.bind(controller));
router.post("/:id/close/explanation", requirePermission("cash.shift.manage"), controller.resubmitCloseExplanation.bind(controller));
router.post("/:id/close", requirePermission("cash.shift.manage"), controller.closeShift.bind(controller));

export default router;
