import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";

export type NotificationScope = { businessId: string; userId: string; permissions: string[] };
export type Notification = {
  id: string;
  type: "LOT_EXPIRY" | "SCRAP_PENDING" | "AUDIT_ASSIGNED";
  title: string;
  message: string;
  href: string;
  occurredAt: string;
};

// An alert remains in the inbox while its underlying task/risk is active.
// Reading never changes the source document's approval/workflow state.
export async function activeNotifications(scope: NotificationScope, now = new Date()): Promise<Notification[]> {
  const { businessId, userId, permissions } = scope;
  const can = (code: string) => permissions.includes(code);
  const today = new Date(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now) + "T00:00:00Z");
  const cutoff = new Date(today.getTime() + 60 * 86400000);
  const [lots, scraps, tasks] = await Promise.all([
    can("inventory.read") && can("inventory.lot.read") ? prisma.productLotItem.findMany({
      where: { businessId, status: { in: ["HEALTHY", "WARNING", "UNUSABLE"] },
        expirationDate: { lte: cutoff }, inventoryBalances: { some: { businessId, quantityOnHand: { gt: 0 } } } },
      include: { lot: { select: { lotNumber: true } }, variant: { select: { sku: true, template: { select: { name: true } } } } },
    }) : [],
    can("inventory.read") && can("inventory.lot.read") && can("inventory.scrap.approve") ? prisma.scrapOrder.findMany({
      where: { businessId, status: "PENDING" },
      select: { id: true, scrapCode: true, scrapQty: true, createdAt: true },
    }) : [],
    can("inventory.read") && can("inventory.audit.count") ? prisma.stockAuditItem.findMany({
      where: { assignedToUserId: userId, itemStatus: "IN_PROGRESS", audit: { businessId, status: "IN_PROGRESS" } },
      select: { id: true, auditId: true, rejectedAt: true, audit: { select: { countStartAt: true } }, variant: { select: { sku: true } } },
    }) : [],
  ]);
  const notifications: Notification[] = [];
  for (const lot of lots) {
    const days = Math.round((lot.expirationDate.getTime() - today.getTime()) / 86400000);
    const stage = days < 0 ? "expired" : days <= 7 ? "unusable" : "warning";
    notifications.push({
      id: `lot:${lot.id}:${lot.expirationDate.toISOString().slice(0, 10)}:${stage}`,
      type: "LOT_EXPIRY",
      title: days < 0 ? "Lô hàng đã hết hạn" : days <= 7 ? "Lô hàng cần xử lý ngay" : "Lô hàng sắp hết hạn",
      message: `${lot.variant.template.name} (${lot.variant.sku}), lô ${lot.lot.lotNumber}: ${days < 0 ? `đã hết hạn ${-days} ngày` : `còn ${days} ngày đến hạn`}.`,
      href: "/inventory/lots",
      occurredAt: new Date(lot.expirationDate.getTime() - (stage === "warning" ? 60 : stage === "unusable" ? 7 : -1) * 86400000).toISOString(),
    });
  }
  for (const scrap of scraps) notifications.push({
    id: `scrap:${scrap.id}`, type: "SCRAP_PENDING", title: "Phiếu hủy chờ duyệt",
    message: `${scrap.scrapCode}: ${scrap.scrapQty} đơn vị đang chờ bạn xem xét.`,
    href: `/inventory/scrap/${scrap.id}`, occurredAt: (scrap.createdAt ?? new Date(0)).toISOString(),
  });
  for (const task of tasks) {
    const occurredAt = task.rejectedAt ?? task.audit.countStartAt;
    if (!occurredAt) throw new Error(`In-progress stock audit task ${task.id} has no count start time.`);
    notifications.push({
      id: `audit:${task.id}:${task.rejectedAt?.toISOString() ?? "assigned"}`, type: "AUDIT_ASSIGNED",
      title: task.rejectedAt ? "Mục kiểm kê cần đếm lại" : "Bạn có mục kiểm kê được giao",
      message: `Sản phẩm ${task.variant.sku} đang chờ bạn kiểm đếm.`,
      href: `/inventory/audit/${task.auditId}/items/${task.id}`,
      occurredAt: occurredAt.toISOString(),
    });
  }
  return notifications.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
}

export async function listNotifications(scope: NotificationScope, page = 1) {
  const active = await activeNotifications(scope);
  const reads = await prisma.notificationRead.findMany({
    where: { businessId: scope.businessId, userId: scope.userId },
    select: { notificationId: true, readAt: true },
  });
  const readMap = new Map(reads.map(read => [read.notificationId, read.readAt.toISOString()]));
  // Keep unread tasks first so the dropdown always offers actionable unseen items.
  active.sort((a, b) => Number(readMap.has(a.id)) - Number(readMap.has(b.id)));
  return {
    items: active.slice((page - 1) * 20, page * 20).map(item => ({ ...item, readAt: readMap.get(item.id) ?? null })),
    total: active.length, unreadCount: active.filter(item => !readMap.has(item.id)).length, page, pageSize: 20,
  };
}

export async function markNotificationsRead(scope: NotificationScope, ids: unknown) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some(id => typeof id !== "string" || id.length > 200)) {
    throw new HttpError(400, "Danh sách thông báo không hợp lệ (tối đa 100 mục).");
  }
  const active = new Set((await activeNotifications(scope)).map(item => item.id));
  if (ids.some(id => !active.has(id))) throw new HttpError(404, "Thông báo không tồn tại hoặc bạn không có quyền truy cập.");
  await prisma.notificationRead.createMany({
    data: [...new Set(ids as string[])].map(notificationId => ({ businessId: scope.businessId, userId: scope.userId, notificationId })),
    skipDuplicates: true,
  });
}
