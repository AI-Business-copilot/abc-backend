import type { Request, Response } from "express";
import { vendorReturnsService } from "./vendor-returns.service";
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

export class VendorReturnsController {
  async listReturns(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const userRole = String(res.locals.businessRole || "OWNER");
      const result = await vendorReturnsService.listReturns(
        businessId,
        {
          search: req.query.search ? String(req.query.search) : undefined,
          status: req.query.status ? String(req.query.status) : undefined,
          supplierId: req.query.supplierId ? String(req.query.supplierId) : undefined,
          page: req.query.page ? Number(req.query.page) : undefined,
          pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
        },
        userRole,
      );
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async createReturn(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const userRole = String(res.locals.businessRole || "OWNER");
      const permissionCodes = (res.locals.permissionCodes as string[]) || [];
      const userId = await resolveCurrentUserId(req, res);

      const result = await vendorReturnsService.createReturn(
        businessId,
        userId,
        req.body ?? {},
        userRole,
        permissionCodes,
      );
      return res.status(201).json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async getReturn(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const userRole = String(res.locals.businessRole || "OWNER");
      const id = String(req.params.id || "");
      const result = await vendorReturnsService.getReturnById(businessId, id, userRole);
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }

  async getSuppliers(req: Request, res: Response) {
    try {
      const businessId = String(res.locals.businessId || "");
      const result = await vendorReturnsService.getSuppliers(businessId);
      return res.json(result);
    } catch (err: any) {
      return fail(res, err);
    }
  }
}

export const vendorReturnsController = new VendorReturnsController();
