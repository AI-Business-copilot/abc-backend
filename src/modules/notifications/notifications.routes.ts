import { Router } from "express";
import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { HttpError } from "../../shared/http/http-error";
import { listNotifications, markNotificationsRead, NotificationScope } from "./notifications.service";

const router = Router();
router.use(requireSupabaseIdentity, requireBusinessScope);
const scope = (locals: Record<string, any>): NotificationScope => ({
  businessId: String(locals.businessId), userId: String(locals.userId), permissions: locals.permissionCodes ?? [],
});
router.get("/", async (req, res) => {
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new HttpError(400, "Trang không hợp lệ.");
  res.setHeader("Cache-Control", "no-store");
  res.json(await listNotifications(scope(res.locals), page));
});
router.post("/read", async (req, res) => {
  await markNotificationsRead(scope(res.locals), req.body?.ids);
  res.status(204).end();
});
export default router;
