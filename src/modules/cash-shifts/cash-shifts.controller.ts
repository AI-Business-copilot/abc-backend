import type { Request, Response } from "express";

import { CashShiftsService } from "./cash-shifts.service";

const service = new CashShiftsService();

const hasPermission = (res: Response, permission: string) =>
  ((res.locals.permissionCodes as string[] | undefined) ?? []).includes(permission);

export class CashShiftsController {
  async summary(_req: Request, res: Response) {
    const result = await service.getSummary(
      String(res.locals.businessId ?? ""),
      hasPermission(res, "cash.shift.reconcile"),
    );
    return res.json(result);
  }

  async previewHandoff(req: Request, res: Response) {
    const result = await service.previewHandoff(
      String(res.locals.businessId ?? ""),
      req.body?.openingCash,
      hasPermission(res, "cash.shift.reconcile"),
    );
    return res.json(result);
  }

  async openShift(req: Request, res: Response) {
    const result = await service.openShift(
      String(res.locals.businessId ?? ""),
      String(res.locals.userId ?? ""),
      req.body ?? {},
      hasPermission(res, "cash.shift.reconcile"),
    );
    return res.status(201).json(result);
  }

  async recordTransaction(req: Request, res: Response) {
    const result = await service.recordTransaction(
      String(res.locals.businessId ?? ""),
      String(res.locals.userId ?? ""),
      String(req.params.id),
      req.body ?? {},
    );
    return res.status(201).json(result);
  }

  async previewClose(req: Request, res: Response) {
    const result = await service.previewClose(
      String(res.locals.businessId ?? ""),
      String(res.locals.userId ?? ""),
      String(req.params.id),
      req.body?.actualCash,
    );
    return res.json(result);
  }

  async closeShift(req: Request, res: Response) {
    const result = await service.closeShift(
      String(res.locals.businessId ?? ""),
      String(res.locals.userId ?? ""),
      String(req.params.id),
      req.body ?? {},
      hasPermission(res, "cash.shift.reconcile"),
    );
    return res.json(result);
  }

  async resubmitCloseExplanation(req: Request, res: Response) {
    const result = await service.resubmitCloseExplanation(
      String(res.locals.businessId ?? ""),
      String(res.locals.userId ?? ""),
      String(req.params.id),
      req.body ?? {},
      hasPermission(res, "cash.shift.reconcile"),
    );
    return res.json(result);
  }

  async resubmitHandoffExplanation(req: Request, res: Response) {
    const result = await service.resubmitHandoffExplanation(
      String(res.locals.businessId ?? ""),
      String(res.locals.userId ?? ""),
      String(req.params.id),
      req.body?.explanation,
    );
    return res.json(result);
  }

  async withdraw(req: Request, res: Response) {
    const result = await service.recordWithdrawal(
      String(res.locals.businessId ?? ""),
      String(res.locals.userId ?? ""),
      String(req.params.id),
      req.body ?? {},
    );
    return res.status(201).json(result);
  }

  async reviewQueue(_req: Request, res: Response) {
    const result = await service.getReviewQueue(String(res.locals.businessId ?? ""));
    return res.json(result);
  }

  async decideCloseReview(req: Request, res: Response) {
    const result = await service.decideCloseReview(
      String(res.locals.businessId ?? ""),
      String(res.locals.userId ?? ""),
      String(req.params.reviewId),
      req.body ?? {},
    );
    return res.json(result);
  }

  async decideHandoffReview(req: Request, res: Response) {
    const result = await service.decideHandoffReview(
      String(res.locals.businessId ?? ""),
      String(res.locals.userId ?? ""),
      String(req.params.reviewId),
      req.body ?? {},
    );
    return res.json(result);
  }
}
