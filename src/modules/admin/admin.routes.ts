import { Router } from "express";
import { Prisma } from "@prisma/client";

import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { ensureUserProfile } from "../../shared/auth/user-profile.service";
import { getAccessContext } from "../../shared/auth/access-context.service";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";
import { isConfiguredSystemAdminEmail } from "../../shared/auth/system-admin-bootstrap.service";

const router = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requirePlatformAccess(req: Express.Request, permission: string) {
  if (!req.identity?.emailVerified) {
    throw new HttpError(req.identity ? 403 : 401, "A verified account is required.");
  }
  const user = await ensureUserProfile(req.identity);
  const access = await getAccessContext(user.id);
  if (!access.permissionCodes.includes(permission)) {
    throw new HttpError(403, "You do not have permission to manage the platform.");
  }
  return user;
}

function readBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "A JSON object is required.");
  }
  return body as Record<string, unknown>;
}

function routeId(value: unknown, name: string) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new HttpError(400, `${name} must be a UUID.`);
  }
  return value;
}

function pagination(query: Record<string, unknown>) {
  const page = Number(query.page ?? 1);
  const pageSize = Number(query.pageSize ?? 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new HttpError(400, "page must be positive and pageSize must be between 1 and 100.");
  }
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function requiredReason(body: Record<string, unknown>) {
  const reason = body.reason;
  if (typeof reason !== "string" || reason.trim().length < 5 || reason.trim().length > 1000) {
    throw new HttpError(400, "A reason of 5 to 1000 characters is required.");
  }
  return reason.trim();
}

function stringValue(body: Record<string, unknown>, key: string, maxLength: number) {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `${key} is required and must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

router.get("/dashboard", requireSupabaseIdentity, async (req, res) => {
  if (!req.identity?.emailVerified) {
    throw new HttpError(req.identity ? 403 : 401, "A verified account is required.");
  }
  const user = await ensureUserProfile(req.identity);
  const access = await getAccessContext(user.id);
  if (
    !access.permissionCodes.includes("platform.users.manage") ||
    !access.permissionCodes.includes("platform.businesses.manage")
  ) {
    throw new HttpError(403, "You do not have permission to view the platform dashboard.");
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [userCount, activeUserCount, suspendedUserCount, businessCount, activeBusinessCount, suspendedBusinessCount, newBusinessCount, recentLogs] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { status: "ACTIVE" } }),
      prisma.user.count({ where: { status: "SUSPENDED" } }),
      prisma.business.count(),
      prisma.business.count({ where: { status: "ACTIVE" } }),
      prisma.business.count({ where: { status: "SUSPENDED" } }),
      prisma.business.count({ where: { createdAt: { gte: since } } }),
      access.permissionCodes.includes("platform.audit.read")
        ? prisma.platformAuditLog.findMany({
        take: 8,
        orderBy: { createdAt: "desc" },
        include: {
          actor: { select: { id: true, email: true, fullName: true } },
          business: { select: { id: true, name: true } },
        },
        })
        : Promise.resolve([]),
    ]);

  res.json({
    totals: { users: userCount, activeUsers: activeUserCount, suspendedUsers: suspendedUserCount, businesses: businessCount, activeBusinesses: activeBusinessCount, suspendedBusinesses: suspendedBusinessCount, newBusinesses30d: newBusinessCount },
    recentActivity: recentLogs,
  });
});

router.get("/users", requireSupabaseIdentity, async (req, res) => {
  await requirePlatformAccess(req, "platform.users.manage");
  const { page, pageSize, skip } = pagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 200) : "";
  const status = typeof req.query.status === "string" ? req.query.status : "";
  if (status && !["ACTIVE", "SUSPENDED"].includes(status)) {
    throw new HttpError(400, "status must be ACTIVE or SUSPENDED.");
  }
  const where = {
    ...(status ? { status } : {}),
    ...(search ? {
      OR: [
        { email: { contains: search, mode: "insensitive" as const } },
        { fullName: { contains: search, mode: "insensitive" as const } },
      ],
    } : {}),
  };
  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      select: {
        id: true, email: true, fullName: true, status: true, createdAt: true,
        memberships: {
          where: { status: { in: ["ACTIVE", "SUSPENDED"] } },
          take: 1,
          select: {
            status: true,
            role: { select: { code: true, displayName: true } },
            business: { select: { id: true, name: true, status: true } },
          },
        },
        platformRoles: { select: { role: { select: { code: true, displayName: true } } } },
      },
    }),
  ]);
  res.json({
    users: users.map((user) => ({
      ...user,
      isBootstrapAdmin: isConfiguredSystemAdminEmail(user.email),
    })),
    page,
    pageSize,
    total,
  });
});

router.patch("/users/:userId/status", requireSupabaseIdentity, async (req, res) => {
  const actor = await requirePlatformAccess(req, "platform.users.manage");
  const userId = routeId(req.params.userId, "userId");
  const body = readBody(req.body);
  const status = body.status;
  if (status !== "ACTIVE" && status !== "SUSPENDED") {
    throw new HttpError(400, "status must be ACTIVE or SUSPENDED.");
  }
  const reason = requiredReason(body);
  if (userId === actor.id && status === "SUSPENDED") {
    throw new HttpError(409, "You cannot suspend your own account.");
  }
  const updated = await prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({
      where: { id: userId },
      include: { platformRoles: { include: { role: true } } },
    });
    if (!target) throw new HttpError(404, "User not found.");
    if (target.status === status) return target;
    if (status === "SUSPENDED" && isConfiguredSystemAdminEmail(target.email)) {
      throw new HttpError(409, "The configured bootstrap administrator account cannot be suspended.");
    }
    if (status === "SUSPENDED" && target.platformRoles.some(({ role }) => role.code === "SYSTEM_ADMIN")) {
      const activeAdmins = await tx.platformUserRole.count({
        where: { role: { code: "SYSTEM_ADMIN" }, user: { status: "ACTIVE" } },
      });
      if (activeAdmins <= 1) throw new HttpError(409, "The last active system administrator cannot be suspended.");
    }
    const user = await tx.user.update({ where: { id: userId }, data: { status } });
    await tx.platformAuditLog.create({
      data: {
        actorUserId: actor.id, action: status === "SUSPENDED" ? "user.suspend" : "user.restore",
        targetType: "USER", targetId: userId, reason,
        changes: { status: { from: target.status, to: status } },
      },
    });
    return user;
  }, { isolationLevel: "Serializable" });
  res.json({ user: { id: updated.id, status: updated.status } });
});

router.patch("/users/:userId/system-admin", requireSupabaseIdentity, async (req, res) => {
  if (!process.env.SYSTEM_ADMIN_EMAIL?.trim()) {
    throw new HttpError(503, "SYSTEM_ADMIN_EMAIL must be configured to manage System Admin roles.");
  }
  const actor = await requirePlatformAccess(req, "platform.roles.manage");
  if (!isConfiguredSystemAdminEmail(actor.email)) {
    throw new HttpError(403, "Only the configured bootstrap administrator can manage System Admin roles.");
  }
  const userId = routeId(req.params.userId, "userId");
  const body = readBody(req.body);
  if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean.");
  const enabled = body.enabled;
  const reason = requiredReason(body);
  if (!enabled && userId === actor.id) throw new HttpError(409, "You cannot revoke your own system administrator role.");

  const result = await prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({
      where: { id: userId },
      include: { platformRoles: { include: { role: true } } },
    });
    if (!target) throw new HttpError(404, "User not found.");
    if (!enabled && isConfiguredSystemAdminEmail(target.email)) {
      throw new HttpError(409, "The configured bootstrap administrator role cannot be revoked.");
    }
    const systemAdminRole = await tx.role.findUnique({ where: { code: "SYSTEM_ADMIN" } });
    if (!systemAdminRole || systemAdminRole.scope !== "PLATFORM") {
      throw new HttpError(503, "The system administrator role has not been initialized.");
    }
    if (enabled) {
      const businessMembership = await tx.businessMembership.findFirst({
        where: { userId, status: { in: ["ACTIVE", "SUSPENDED"] } },
        select: { id: true },
      });
      if (businessMembership) {
        throw new HttpError(
          409,
          "A user with an active or suspended business membership cannot become a System Admin. Remove the business membership first.",
        );
      }
    }
    const currentlyAdmin = target.platformRoles.some(({ role }) => role.id === systemAdminRole.id);
    if (currentlyAdmin === enabled) return target;
    if (!enabled && target.status === "ACTIVE") {
      const activeAdmins = await tx.platformUserRole.count({
        where: { roleId: systemAdminRole.id, user: { status: "ACTIVE" } },
      });
      if (activeAdmins <= 1) throw new HttpError(409, "The last active system administrator role cannot be revoked.");
    }
    if (enabled) {
      await tx.platformUserRole.create({ data: { userId, roleId: systemAdminRole.id } });
    } else {
      await tx.platformUserRole.delete({ where: { userId_roleId: { userId, roleId: systemAdminRole.id } } });
    }
    await tx.platformAuditLog.create({
      data: {
        actorUserId: actor.id, action: enabled ? "user.system_admin.grant" : "user.system_admin.revoke",
        targetType: "USER", targetId: userId, reason,
        changes: { systemAdmin: { from: currentlyAdmin, to: enabled } },
      },
    });
    return { ...target, platformRoles: enabled ? [...target.platformRoles, { userId, roleId: systemAdminRole.id, createdAt: new Date(), role: systemAdminRole }] : target.platformRoles.filter(({ role }) => role.id !== systemAdminRole.id) };
  }, { isolationLevel: "Serializable" });
  res.json({ user: { id: result.id, systemAdmin: result.platformRoles.some(({ role }) => role.code === "SYSTEM_ADMIN") } });
});

router.get("/businesses", requireSupabaseIdentity, async (req, res) => {
  await requirePlatformAccess(req, "platform.businesses.manage");
  const { page, pageSize, skip } = pagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 200) : "";
  const status = typeof req.query.status === "string" ? req.query.status : "";
  if (status && !["ACTIVE", "SUSPENDED"].includes(status)) {
    throw new HttpError(400, "status must be ACTIVE or SUSPENDED.");
  }
  const where = {
    ...(status ? { status } : {}),
    ...(search ? { OR: [
      { name: { contains: search, mode: "insensitive" as const } },
      { phone: { contains: search, mode: "insensitive" as const } },
    ] } : {}),
  };
  const [total, businesses] = await Promise.all([
    prisma.business.count({ where }),
    prisma.business.findMany({
      where, skip, take: pageSize, orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, phone: true, address: true, industryType: true, status: true, createdAt: true,
        memberships: {
          where: { status: { in: ["ACTIVE", "SUSPENDED"] }, role: { code: "OWNER" } },
          take: 1,
          select: { status: true, role: { select: { code: true } }, user: { select: { id: true, email: true, fullName: true } } },
        },
        _count: {
          select: { memberships: { where: { status: { in: ["ACTIVE", "SUSPENDED"] } } } },
        },
      },
    }),
  ]);
  res.json({ businesses, page, pageSize, total });
});

router.patch("/businesses/:businessId", requireSupabaseIdentity, async (req, res) => {
  const actor = await requirePlatformAccess(req, "platform.businesses.manage");
  const businessId = routeId(req.params.businessId, "businessId");
  const body = readBody(req.body);
  const name = stringValue(body, "name", 255);
  const phone = stringValue(body, "phone", 20);
  const industryType = stringValue(body, "industryType", 50);
  if (body.address !== null && body.address !== undefined && typeof body.address !== "string") {
    throw new HttpError(400, "address must be a string or null.");
  }
  const address = typeof body.address === "string" ? body.address.trim() : null;
  if (address && address.length > 10_000) throw new HttpError(400, "address must be at most 10000 characters.");
  const before = await prisma.business.findUnique({ where: { id: businessId } });
  if (!before) throw new HttpError(404, "Business not found.");
  const data = { name, phone, industryType, address };
  const updated = await prisma.$transaction(async (tx) => {
    const business = await tx.business.update({ where: { id: businessId }, data });
    await tx.platformAuditLog.create({
      data: {
        actorUserId: actor.id, businessId, action: "business.update", targetType: "BUSINESS", targetId: businessId,
        changes: {
          name: { from: before.name, to: name }, phone: { from: before.phone, to: phone },
          industryType: { from: before.industryType, to: industryType }, address: { from: before.address, to: address },
        },
      },
    });
    return business;
  });
  res.json({ business: updated });
});

router.patch("/businesses/:businessId/status", requireSupabaseIdentity, async (req, res) => {
  const actor = await requirePlatformAccess(req, "platform.businesses.manage");
  const businessId = routeId(req.params.businessId, "businessId");
  const body = readBody(req.body);
  const status = body.status;
  if (status !== "ACTIVE" && status !== "SUSPENDED") {
    throw new HttpError(400, "status must be ACTIVE or SUSPENDED.");
  }
  const reason = requiredReason(body);
  const target = await prisma.business.findUnique({ where: { id: businessId } });
  if (!target) throw new HttpError(404, "Business not found.");
  if (target.status === status) return res.json({ business: { id: target.id, status } });
  await prisma.$transaction(async (tx) => {
    await tx.business.update({ where: { id: businessId }, data: { status } });
    await tx.platformAuditLog.create({
      data: {
        actorUserId: actor.id, businessId,
        action: status === "SUSPENDED" ? "business.suspend" : "business.restore",
        targetType: "BUSINESS", targetId: businessId, reason,
        changes: { status: { from: target.status, to: status } },
      },
    });
  });
  res.json({ business: { id: target.id, status } });
});

router.get("/audit-logs", requireSupabaseIdentity, async (req, res) => {
  await requirePlatformAccess(req, "platform.audit.read");
  const { page, pageSize, skip } = pagination(req.query);
  const businessId = req.query.businessId ? routeId(req.query.businessId, "businessId") : undefined;
  const action = typeof req.query.action === "string" ? req.query.action.trim().slice(0, 100) : "";
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 200) : "";
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  const sort = req.query.sort === undefined ? "newest" : String(req.query.sort);
  if (sort !== "newest" && sort !== "oldest") {
    throw new HttpError(400, "sort must be newest or oldest.");
  }
  const parseDate = (value: string, key: string) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new HttpError(400, `${key} must use YYYY-MM-DD format.`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new HttpError(400, `${key} must be a valid calendar date.`);
    }
    return parsed;
  };
  const fromDate = parseDate(from, "from");
  const toDate = parseDate(to, "to");
  if (fromDate && toDate && fromDate > toDate) {
    throw new HttpError(400, "from must be on or before to.");
  }
  const searchConditions: Prisma.PlatformAuditLogWhereInput[] = search
    ? [
      { action: { contains: search, mode: "insensitive" } },
      { targetType: { contains: search, mode: "insensitive" } },
      { reason: { contains: search, mode: "insensitive" } },
      { actor: { fullName: { contains: search, mode: "insensitive" } } },
      { actor: { email: { contains: search, mode: "insensitive" } } },
      { business: { name: { contains: search, mode: "insensitive" } } },
      ...(uuidPattern.test(search) ? [{ targetId: search }] : []),
    ]
    : [];
  const where: Prisma.PlatformAuditLogWhereInput = {
    ...(businessId ? { businessId } : {}),
    ...(action ? { action } : {}),
    ...(search ? { OR: searchConditions } : {}),
    ...(fromDate || toDate
      ? {
        createdAt: {
          ...(fromDate ? { gte: fromDate } : {}),
          ...(toDate ? { lt: new Date(toDate.getTime() + 24 * 60 * 60 * 1000) } : {}),
        },
      }
      : {}),
  };
  const [total, logs, actions] = await Promise.all([
    prisma.platformAuditLog.count({ where }),
    prisma.platformAuditLog.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: [{ createdAt: sort === "newest" ? "desc" : "asc" }, { id: "desc" }],
      include: {
        actor: { select: { id: true, email: true, fullName: true } },
        business: { select: { id: true, name: true } },
      },
    }),
    prisma.platformAuditLog.findMany({
      where: businessId ? { businessId } : undefined,
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    }),
  ]);
  res.json({ logs, actions: actions.map(({ action: actionName }) => actionName), page, pageSize, total });
});

export default router;
