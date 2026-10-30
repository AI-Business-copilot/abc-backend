import type { Request, Response } from "express";
import { customerReturnsService } from "./customer-returns.service";
import { prisma } from "../../shared/infrastructure/database/prisma.client";

const fail = (res: Response, err: any) => {
  console.error(err);
  const status = err.statusCode || err.status || 500;
  return res.status(status).json({
    message: err.message || "Lỗi hệ thống",
    error: err.message || "Lỗi hệ thống",
  });
};

async function resolveCurrentUserId(req: Request, res: Response): Promise<string> {
  if (res.locals.userId) {
    return String(res.locals.userId);
  }
  const authId = String(req.identity?.id || "");
  if (authId) {
    const user = await prisma.user.findUnique({ where: { authUserId: authId } });
    if (user) return user.id;
  }
  return "";
}

export class CustomerReturnsController {
  async listReturns(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await customerReturnsService.listReturns(businessId, {
        search: req.query.search ? String(req.query.search) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      });
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async lookupOrder(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const orderCode = String(req.params.orderCode || "");
      const result = await customerReturnsService.lookupOrder(businessId, orderCode);
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async createReturn(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const userId = await resolveCurrentUserId(req, res);
      const result = await customerReturnsService.createReturn(businessId, userId, req.body ?? {});
      return res.status(201).json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async getReturn(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const id = String(req.params.id || "");
      const result = await customerReturnsService.getReturnById(businessId, id);
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }
}

export const customerReturnsController = new CustomerReturnsController();
