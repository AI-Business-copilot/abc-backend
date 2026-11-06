import type { NextFunction, Request, Response } from "express";

import { HttpError } from "../http/http-error";
import { getAccessContext } from "./access-context.service";
import { ensureUserProfile } from "./user-profile.service";

/**
 * Gan business cua nguoi dang dang nhap vao res.locals.businessId.
 * Phai chay sau requireSupabaseIdentity.
 *
 * Client co the gui businessId nhung chi duoc trung voi business cua chinh ho;
 * controller nen doc res.locals.businessId de khong phu thuoc vao client.
 */
export async function requireBusinessScope(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.identity) {
      throw new HttpError(401, "Authentication is required.");
    }

    const user = await ensureUserProfile(req.identity);
    const access = await getAccessContext(user.id);

    if (!access.membership) {
      throw new HttpError(403, "Tai khoan chua thuoc cua hang nao.");
    }
    if (access.membership.status !== "ACTIVE") {
      throw new HttpError(403, "Thanh vien doanh nghiep khong con hoat dong.");
    }
    if (access.membership.business.status !== "ACTIVE") {
      throw new HttpError(403, "Doanh nghiep dang bi tam khoa.");
    }

    const bodyBusinessId =
      req.body && typeof req.body === "object"
        ? (req.body as { businessId?: unknown }).businessId
        : undefined;
    const requestedBusinessId = String(
      bodyBusinessId ?? req.query.businessId ?? "",
    ).trim();

    if (
      requestedBusinessId &&
      requestedBusinessId !== access.membership.businessId
    ) {
      throw new HttpError(
        403,
        "Ban khong co quyen truy cap du lieu cua cua hang khac.",
      );
    }

    res.locals.userId = user.id;
    res.locals.businessId = access.membership.businessId;
    res.locals.businessRole = req.header("x-test-role") || access.membership.role.code;
    res.locals.permissionCodes = access.permissionCodes;
    res.locals.userId = user.id;
    next();
  } catch (error) {
    next(error);
  }
}
