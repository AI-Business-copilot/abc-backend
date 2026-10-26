import type { NextFunction, Request, Response } from "express";

import { HttpError } from "../http/http-error";

/**
 * Chan request neu tai khoan dang nhap khong co quyen tuong ung.
 * Phai chay sau requireSupabaseIdentity + requireBusinessScope.
 */
export function requirePermission(permissionCode: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const codes = (res.locals.permissionCodes as string[] | undefined) ?? [];
    if (!codes.includes(permissionCode)) {
      next(new HttpError(403, "Ban khong co quyen thuc hien thao tac nay."));
      return;
    }
    next();
  };
}
