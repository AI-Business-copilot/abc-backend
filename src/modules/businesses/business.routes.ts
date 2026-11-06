import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { Router } from "express";

import { getAccessContext } from "../../shared/auth/access-context.service";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { ensureUserProfile } from "../../shared/auth/user-profile.service";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";
import { isAssignableBusinessPermission } from "./business-role-policy";

const router = Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InvitationAuthConfig {
  supabaseUrl: URL;
  anonKey: string;
  serviceRoleKey: string;
  redirectUrl: URL;
}

function getInvitationAuthConfig(): InvitationAuthConfig {
  const supabaseUrlValue = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const redirectUrlValue = process.env.SUPABASE_AUTH_REDIRECT_URL;
  if (!supabaseUrlValue || !anonKey || !serviceRoleKey || !redirectUrlValue) {
    throw new HttpError(
      503,
      "Invitation email is not configured. Set the backend Supabase API key, service role key, and auth redirect URL.",
    );
  }

  try {
    return {
      supabaseUrl: new URL(supabaseUrlValue),
      anonKey,
      serviceRoleKey,
      redirectUrl: new URL(redirectUrlValue),
    };
  } catch {
    throw new HttpError(500, "The Supabase invitation URL configuration is invalid.");
  }
}

function readBody(req: { body: unknown }): Record<string, unknown> {
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
    throw new HttpError(400, "A JSON object is required.");
  }
  return req.body as Record<string, unknown>;
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `${key} is required and must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

function requireVerifiedIdentity(identity: Express.Request["identity"]) {
  if (!identity) {
    throw new HttpError(401, "Authentication is required.");
  }
  if (!identity.emailVerified) {
    throw new HttpError(403, "Verify your email address before continuing.");
  }
  return identity;
}

function requireActiveBusiness(access: Awaited<ReturnType<typeof getAccessContext>>) {
  if (!access.membership) {
    throw new HttpError(403, "This account does not belong to a business.");
  }
  if (access.membership.status !== "ACTIVE") {
    throw new HttpError(403, "This business membership is not active.");
  }
  if (access.membership.business.status !== "ACTIVE") {
    throw new HttpError(403, "This business is suspended.");
  }
  return access.membership;
}

async function requireBusinessRoleManager(identity: Express.Request["identity"]) {
  const verifiedIdentity = requireVerifiedIdentity(identity);
  const user = await ensureUserProfile(verifiedIdentity);
  const access = await getAccessContext(user.id);
  const membership = requireActiveBusiness(access);
  if (
    membership.role.code !== "OWNER" ||
    !access.permissionCodes.includes("business.roles.manage")
  ) {
    throw new HttpError(403, "Only a business owner can manage business roles.");
  }
  return { user, membership };
}

function readPermissionCodes(body: Record<string, unknown>) {
  const value = body.permissionCodes;
  if (
    !Array.isArray(value) ||
    value.some((code) => typeof code !== "string" || !code.trim()) ||
    new Set(value).size !== value.length
  ) {
    throw new HttpError(400, "permissionCodes must be an array of unique permission codes.");
  }
  return value as string[];
}

function readRoleReason(body: Record<string, unknown>) {
  const reason = requiredString(body, "reason", 1000);
  if (reason.length < 5) throw new HttpError(400, "reason must be at least 5 characters.");
  return reason;
}

async function resolveAssignablePermissions(permissionCodes: string[]) {
  if (permissionCodes.length === 0) {
    throw new HttpError(400, "At least one business permission must be assigned.");
  }
  const permissions = await prisma.permission.findMany({
    where: { code: { in: permissionCodes } },
    select: { id: true, code: true, scope: true },
  });
  const allowedCodes = new Set(
    permissions.filter(isAssignableBusinessPermission).map(({ code }) => code),
  );
  const invalidCodes = permissionCodes.filter((code) => !allowedCodes.has(code));
  if (invalidCodes.length > 0) {
    throw new HttpError(400, `These permissions cannot be assigned to business roles: ${invalidCodes.join(", ")}.`);
  }
  return permissions;
}

async function sendSupabaseInvitation(
  email: string,
  invitationId: string,
  token: string,
  config: InvitationAuthConfig,
): Promise<void> {
  const redirect = new URL(config.redirectUrl);
  redirect.searchParams.set("invitation_token", token);

  let response: globalThis.Response;
  try {
    const endpoint = new URL("/auth/v1/invite", config.supabaseUrl);
    endpoint.searchParams.set("redirect_to", redirect.toString());
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        data: { business_invitation_id: invitationId },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "Supabase Auth could not be reached to send the invitation.");
  }

  if (!response.ok) {
    const responseBody = await response.text();
    if (
      response.status === 422 &&
      /already registered|already exists|email_exists/i.test(responseBody)
    ) {
      await sendMagicLinkForExistingUser(email, redirect, config);
      return;
    }

    throw new HttpError(
      502,
      "Supabase Auth did not send the invitation. Check the Auth email/SMTP configuration and whether this email can be invited.",
    );
  }
}

async function sendMagicLinkForExistingUser(
  email: string,
  redirect: URL,
  config: InvitationAuthConfig,
): Promise<void> {
  try {
    const endpoint = new URL("/auth/v1/otp", config.supabaseUrl);
    endpoint.searchParams.set("redirect_to", redirect.toString());
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, create_user: false }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      return;
    }
  } catch {
    throw new HttpError(502, "Supabase Auth could not send a sign-in link to the invited account.");
  }

  throw new HttpError(
    502,
    "Supabase Auth could not send a sign-in link to the existing account. Check the Auth email/SMTP configuration.",
  );
}

router.post("/onboarding", requireSupabaseIdentity, async (req, res) => {
  const identity = requireVerifiedIdentity(req.identity);
  const body = readBody(req);
  const name = requiredString(body, "name", 255);
  const phone = requiredString(body, "phone", 20);
  const industryType = requiredString(body, "industryType", 50);
  const addressValue = body.address;
  if (addressValue !== undefined && addressValue !== null && typeof addressValue !== "string") {
    throw new HttpError(400, "address must be a string.");
  }
  const address =
    typeof addressValue === "string" && addressValue.trim()
      ? addressValue.trim()
      : undefined;
  if (address && address.length > 10_000) {
    throw new HttpError(400, "address must be at most 10000 characters.");
  }

  const user = await ensureUserProfile(identity);
  const access = await getAccessContext(user.id);
  if (access.platformRoles.length > 0) {
    throw new HttpError(403, "Platform administrators cannot create a business through owner onboarding.");
  }
  const existingMembership = await prisma.businessMembership.findFirst({
    where: { userId: user.id, status: { in: ["ACTIVE", "SUSPENDED"] } },
  });
  if (existingMembership) {
    throw new HttpError(409, "This account already belongs to a business.");
  }

  const ownerRole = await prisma.role.findUnique({ where: { code: "OWNER" } });
  if (!ownerRole || ownerRole.scope !== "BUSINESS") {
    throw new HttpError(503, "The business owner role has not been initialized.");
  }
  const staffTemplate = await prisma.role.findUnique({
    where: { code: "STAFF" },
    include: { permissions: { select: { permissionId: true } } },
  });
  if (!staffTemplate || staffTemplate.scope !== "BUSINESS") {
    throw new HttpError(503, "The default employee role template has not been initialized.");
  }

  const business = await prisma.$transaction(async (tx) => {
    const assignedPlatformRole = await tx.platformUserRole.findFirst({
      where: { userId: user.id, role: { code: "SYSTEM_ADMIN" } },
      select: { userId: true },
    });
    if (assignedPlatformRole) {
      throw new HttpError(409, "System Admin accounts cannot create or join a business.");
    }
    const created = await tx.business.create({
      data: {
        name, phone, industryType, address,
        memberships: { create: { userId: user.id, roleId: ownerRole.id } },
      },
      select: { id: true, name: true, phone: true, industryType: true, address: true },
    });
    await tx.role.create({
      data: {
        code: `BIZ_${randomUUID().replace(/-/g, "")}`,
        scope: "BUSINESS",
        displayName: "Nhân viên cửa hàng",
        description: "Vai trò nhân viên mặc định.",
        businessId: created.id,
        isDefault: true,
        permissions: {
          create: staffTemplate.permissions.map(({ permissionId }) => ({ permissionId })),
        },
      },
    });
    await tx.platformAuditLog.create({
      data: {
        actorUserId: user.id, businessId: created.id, action: "business.create",
        targetType: "BUSINESS", targetId: created.id,
        changes: { name, industryType },
      },
    });
    return created;
  }, { isolationLevel: "Serializable" });

  res.status(201).json({
    business,
    role: ownerRole.code,
  });
});

router.get("/roles", requireSupabaseIdentity, async (req, res) => {
  const { membership } = await requireBusinessRoleManager(req.identity);
  const [roles, permissions] = await Promise.all([
    prisma.role.findMany({
      where: { businessId: membership.businessId, scope: "BUSINESS" },
      orderBy: [{ isArchived: "asc" }, { isDefault: "desc" }, { displayName: "asc" }],
      include: {
        permissions: { include: { permission: { select: { code: true } } } },
        _count: { select: { memberships: true, invitations: true } },
      },
    }),
    prisma.permission.findMany({
      where: { scope: "BUSINESS" },
      orderBy: { code: "asc" },
      select: { code: true, scope: true, description: true },
    }),
  ]);
  res.json({
    roles: roles.map((role) => ({
      id: role.id,
      code: role.code,
      displayName: role.displayName,
      description: role.description,
      isDefault: role.isDefault,
      isArchived: role.isArchived,
      permissionCodes: role.permissions.map(({ permission }) => permission.code),
      memberCount: role._count.memberships,
      invitationCount: role._count.invitations,
    })),
    permissions: permissions
      .filter(isAssignableBusinessPermission)
      .map(({ code, description }) => ({ code, description })),
  });
});

router.post("/roles", requireSupabaseIdentity, async (req, res) => {
  const { user, membership } = await requireBusinessRoleManager(req.identity);
  const body = readBody(req);
  const displayName = requiredString(body, "displayName", 100);
  const description =
    body.description === undefined || body.description === null
      ? null
      : typeof body.description === "string" && body.description.length <= 1000
        ? body.description.trim() || null
        : (() => { throw new HttpError(400, "description must be at most 1000 characters."); })();
  const reason = readRoleReason(body);
  const permissionCodes = readPermissionCodes(body);
  const permissions = await resolveAssignablePermissions(permissionCodes);
  const duplicate = await prisma.role.findFirst({
    where: {
      businessId: membership.businessId,
      displayName: { equals: displayName, mode: "insensitive" },
    },
    select: { id: true },
  });
  if (duplicate) throw new HttpError(409, "A role with this name already exists.");

  const role = await prisma.$transaction(async (tx) => {
    const created = await tx.role.create({
      data: {
        code: `BIZ_${randomUUID().replace(/-/g, "")}`,
        scope: "BUSINESS",
        displayName,
        description,
        businessId: membership.businessId,
        permissions: { create: permissions.map(({ id }) => ({ permissionId: id })) },
      },
      select: { id: true, code: true, displayName: true, description: true, isDefault: true, isArchived: true },
    });
    await tx.platformAuditLog.create({
      data: {
        actorUserId: user.id,
        businessId: membership.businessId,
        action: "business.role.create",
        targetType: "ROLE",
        targetId: created.id,
        reason,
        changes: { displayName, permissionCodes },
      },
    });
    return created;
  });
  res.status(201).json({ role: { ...role, permissionCodes } });
});

router.patch("/roles/:roleId", requireSupabaseIdentity, async (req, res) => {
  const { user, membership } = await requireBusinessRoleManager(req.identity);
  const roleId = typeof req.params.roleId === "string" ? req.params.roleId : "";
  if (!uuidPattern.test(roleId)) throw new HttpError(400, "roleId must be a UUID.");
  const body = readBody(req);
  const target = await prisma.role.findFirst({
    where: { id: roleId, businessId: membership.businessId, scope: "BUSINESS" },
    include: { permissions: { include: { permission: { select: { code: true } } } } },
  });
  if (!target) throw new HttpError(404, "Business role not found.");
  if (target.isArchived) throw new HttpError(409, "Restore this role before editing it.");
  const displayName = body.displayName === undefined
    ? target.displayName
    : requiredString(body, "displayName", 100);
  const description =
    body.description === undefined
      ? target.description
      : body.description === null
        ? null
        : typeof body.description === "string" && body.description.length <= 1000
          ? body.description.trim() || null
          : (() => { throw new HttpError(400, "description must be at most 1000 characters."); })();
  const reason = readRoleReason(body);
  const permissionCodes = readPermissionCodes(body);
  const permissions = await resolveAssignablePermissions(permissionCodes);
  const duplicate = await prisma.role.findFirst({
    where: {
      businessId: membership.businessId,
      id: { not: roleId },
      displayName: { equals: displayName, mode: "insensitive" },
    },
    select: { id: true },
  });
  if (duplicate) throw new HttpError(409, "A role with this name already exists.");

  const previousPermissionCodes = target.permissions.map(({ permission }) => permission.code).sort();
  const updated = await prisma.$transaction(async (tx) => {
    await tx.role.update({
      where: { id: roleId },
      data: {
        displayName,
        description,
        permissions: {
          deleteMany: {},
          create: permissions.map(({ id }) => ({ permissionId: id })),
        },
      },
    });
    await tx.platformAuditLog.create({
      data: {
        actorUserId: user.id,
        businessId: membership.businessId,
        action: "business.role.update",
        targetType: "ROLE",
        targetId: roleId,
        reason,
        changes: {
          displayName: { from: target.displayName, to: displayName },
          permissionCodes: { from: previousPermissionCodes, to: [...permissionCodes].sort() },
        },
      },
    });
    return tx.role.findUniqueOrThrow({
      where: { id: roleId },
      select: { id: true, code: true, displayName: true, description: true, isDefault: true, isArchived: true },
    });
  });
  res.json({ role: { ...updated, permissionCodes } });
});

router.post("/roles/:roleId/archive", requireSupabaseIdentity, async (req, res) => {
  const { user, membership } = await requireBusinessRoleManager(req.identity);
  const roleId = typeof req.params.roleId === "string" ? req.params.roleId : "";
  if (!uuidPattern.test(roleId)) throw new HttpError(400, "roleId must be a UUID.");
  const body = readBody(req);
  const reason = readRoleReason(body);
  const target = await prisma.role.findFirst({
    where: { id: roleId, businessId: membership.businessId, scope: "BUSINESS" },
    select: { id: true, displayName: true, isDefault: true, isArchived: true },
  });
  if (!target) throw new HttpError(404, "Business role not found.");
  if (target.isDefault) throw new HttpError(409, "The default Staff role cannot be archived.");
  if (target.isArchived) throw new HttpError(409, "This role is already archived.");
  await prisma.$transaction(async (tx) => {
    const [membershipCount, pendingInvitationCount] = await Promise.all([
      tx.businessMembership.count({
        where: { businessId: membership.businessId, roleId, status: { in: ["ACTIVE", "SUSPENDED"] } },
      }),
      tx.businessInvitation.count({
        where: { businessId: membership.businessId, roleId, status: "PENDING" },
      }),
    ]);
    if (membershipCount > 0 || pendingInvitationCount > 0) {
      throw new HttpError(409, "Reassign active members and revoke pending invitations before archiving this role.");
    }
    const archived = await tx.role.updateMany({
      where: { id: roleId, businessId: membership.businessId, isArchived: false },
      data: { isArchived: true },
    });
    if (archived.count !== 1) throw new HttpError(409, "This role has already been archived.");
    await tx.platformAuditLog.create({
      data: {
        actorUserId: user.id,
        businessId: membership.businessId,
        action: "business.role.archive",
        targetType: "ROLE",
        targetId: roleId,
        reason,
        changes: { isArchived: { from: false, to: true }, displayName: target.displayName },
      },
    });
  }, { isolationLevel: "Serializable" });
  res.status(204).send();
});

router.post("/roles/:roleId/restore", requireSupabaseIdentity, async (req, res) => {
  const { user, membership } = await requireBusinessRoleManager(req.identity);
  const roleId = typeof req.params.roleId === "string" ? req.params.roleId : "";
  if (!uuidPattern.test(roleId)) throw new HttpError(400, "roleId must be a UUID.");
  const body = readBody(req);
  const reason = readRoleReason(body);
  const target = await prisma.role.findFirst({
    where: { id: roleId, businessId: membership.businessId, scope: "BUSINESS" },
    select: { id: true, displayName: true, isArchived: true },
  });
  if (!target) throw new HttpError(404, "Business role not found.");
  if (!target.isArchived) throw new HttpError(409, "This role is not archived.");
  const duplicate = await prisma.role.findFirst({
    where: {
      businessId: membership.businessId,
      id: { not: roleId },
      displayName: { equals: target.displayName, mode: "insensitive" },
      isArchived: false,
    },
    select: { id: true },
  });
  if (duplicate) throw new HttpError(409, "Rename or archive the role with this name before restoring.");
  await prisma.$transaction(async (tx) => {
    await tx.role.update({ where: { id: roleId }, data: { isArchived: false } });
    await tx.platformAuditLog.create({
      data: {
        actorUserId: user.id,
        businessId: membership.businessId,
        action: "business.role.restore",
        targetType: "ROLE",
        targetId: roleId,
        reason,
        changes: { isArchived: { from: true, to: false }, displayName: target.displayName },
      },
    });
  });
  res.status(204).send();
});

router.patch("/profile", requireSupabaseIdentity, async (req, res) => {
  const identity = requireVerifiedIdentity(req.identity);
  const user = await ensureUserProfile(identity);
  const access = await getAccessContext(user.id);
  const membership = requireActiveBusiness(access);
  if (membership.role.code !== "OWNER" || !access.permissionCodes.includes("business.update")) {
    throw new HttpError(403, "Only a business owner can update business information.");
  }
  const body = readBody(req);
  const name = requiredString(body, "name", 255);
  const phone = requiredString(body, "phone", 20);
  const industryType = requiredString(body, "industryType", 50);
  if (body.address !== undefined && body.address !== null && typeof body.address !== "string") {
    throw new HttpError(400, "address must be a string or null.");
  }
  const address = typeof body.address === "string" && body.address.trim() ? body.address.trim() : null;
  if (address && address.length > 10_000) throw new HttpError(400, "address must be at most 10000 characters.");
  const before = membership.business;
  const updated = await prisma.$transaction(async (tx) => {
    const business = await tx.business.update({
      where: { id: membership.businessId },
      data: { name, phone, industryType, address },
      select: { id: true, name: true, phone: true, industryType: true, address: true, status: true },
    });
    await tx.platformAuditLog.create({
      data: {
        actorUserId: user.id, businessId: membership.businessId,
        action: "business.profile.update", targetType: "BUSINESS", targetId: membership.businessId,
        changes: {
          name: { from: before.name, to: name }, phone: { from: before.phone, to: phone },
          industryType: { from: before.industryType, to: industryType },
          address: { from: before.address, to: address },
        },
      },
    });
    return business;
  });
  res.json({ business: updated });
});

router.post("/invitations", requireSupabaseIdentity, async (req, res) => {
  const identity = requireVerifiedIdentity(req.identity);
  const body = readBody(req);
  const email = requiredString(body, "email", 320).toLowerCase();
  if (!emailPattern.test(email)) {
    throw new HttpError(400, "email must be a valid email address.");
  }

  const user = await ensureUserProfile(identity);
  const access = await getAccessContext(user.id);
  const membership = requireActiveBusiness(access);
  if (membership.role.code !== "OWNER" || !access.permissionCodes.includes("invitations.manage")) {
    throw new HttpError(403, "Only a business owner can invite employees.");
  }

  const invitationAuthConfig = getInvitationAuthConfig();
  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    include: {
      memberships: { select: { businessId: true, status: true } },
      platformRoles: { include: { role: { select: { code: true } } } },
    },
  });
  if (existingUser?.platformRoles.some(({ role }) => role.code === "SYSTEM_ADMIN")) {
    throw new HttpError(409, "System Admin accounts cannot be invited to a business.");
  }
  if (existingUser?.memberships.some(
    (item) => item.status !== "INACTIVE" || item.businessId !== membership.businessId,
  )) {
    throw new HttpError(409, "This account already belongs to a business.");
  }

  const now = new Date();
  await prisma.businessInvitation.updateMany({
    where: {
      businessId: membership.businessId,
      invitedEmail: email,
      status: "PENDING",
      expiresAt: { lte: now },
    },
    data: { status: "EXPIRED" },
  });

  const pendingInvitation = await prisma.businessInvitation.findFirst({
    where: {
      businessId: membership.businessId,
      invitedEmail: email,
      status: "PENDING",
    },
  });
  if (pendingInvitation) {
    throw new HttpError(409, "A pending invitation already exists for this email.");
  }

  const requestedRoleId = body.roleId;
  if (requestedRoleId !== undefined && (typeof requestedRoleId !== "string" || !uuidPattern.test(requestedRoleId))) {
    throw new HttpError(400, "roleId must be a UUID.");
  }
  const invitationRole = requestedRoleId
    ? await prisma.role.findFirst({
      where: {
        id: requestedRoleId,
        businessId: membership.businessId,
        scope: "BUSINESS",
        isArchived: false,
      },
    })
    : await prisma.role.findFirst({
      where: { businessId: membership.businessId, scope: "BUSINESS", isDefault: true, isArchived: false },
    });
  if (!invitationRole) {
    throw new HttpError(400, "Select an active role belonging to this business.");
  }
  if (invitationRole.code === "OWNER") {
    throw new HttpError(400, "Business owners cannot be assigned through an invitation.");
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const invitation = await prisma.$transaction(async (tx) => {
    const activeRole = await tx.role.findFirst({
      where: { id: invitationRole.id, businessId: membership.businessId, scope: "BUSINESS", isArchived: false },
      select: { id: true, code: true, displayName: true },
    });
    if (!activeRole || activeRole.code === "OWNER") {
      throw new HttpError(409, "The selected business role is no longer available.");
    }
    const created = await tx.businessInvitation.create({
      data: {
        businessId: membership.businessId,
        invitedEmail: email,
        roleId: activeRole.id,
        invitedBy: user.id,
        tokenHash,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
      select: { id: true, invitedEmail: true, expiresAt: true },
    });
    await tx.platformAuditLog.create({
      data: {
        actorUserId: user.id, businessId: membership.businessId,
        action: "membership.invitation.create", targetType: "INVITATION", targetId: created.id,
        changes: { email, role: activeRole.code, roleName: activeRole.displayName, status: "PENDING" },
      },
    });
    return { ...created, role: activeRole };
  }, { isolationLevel: "Serializable" });

  try {
    await sendSupabaseInvitation(email, invitation.id, token, invitationAuthConfig);
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await tx.businessInvitation.update({
        where: { id: invitation.id },
        data: { status: "FAILED", emailStatus: "FAILED" },
      });
      await tx.platformAuditLog.create({
        data: {
          actorUserId: user.id, businessId: membership.businessId,
          action: "membership.invitation.delivery_failed", targetType: "INVITATION", targetId: invitation.id,
          changes: { status: { from: "PENDING", to: "FAILED" } },
        },
      });
    });
    throw error;
  }
  await prisma.businessInvitation.update({
    where: { id: invitation.id },
    data: { emailStatus: "SENT" },
  });

  res.status(201).json({
    invitation: {
      id: invitation.id,
      email: invitation.invitedEmail,
      role: invitation.role.code,
      roleId: invitation.role.id,
      roleName: invitation.role.displayName,
      expiresAt: invitation.expiresAt,
      emailStatus: "SENT",
    },
  });
});

router.get("/invitations", requireSupabaseIdentity, async (req, res) => {
  const identity = requireVerifiedIdentity(req.identity);
  const user = await ensureUserProfile(identity);
  const access = await getAccessContext(user.id);
  const membership = requireActiveBusiness(access);
  if (membership.role.code !== "OWNER" || !access.permissionCodes.includes("invitations.manage")) {
    throw new HttpError(403, "Only a business owner can view invitations.");
  }

  const invitations = await prisma.businessInvitation.findMany({
    where: { businessId: membership.businessId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      invitedEmail: true,
      status: true,
      emailStatus: true,
      expiresAt: true,
      createdAt: true,
      role: { select: { id: true, code: true, displayName: true } },
    },
  });

  res.json({
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.invitedEmail,
      role: invitation.role.code,
      roleId: invitation.role.id,
      roleName: invitation.role.displayName,
      status: invitation.status,
      emailStatus: invitation.emailStatus,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    })),
  });
});

router.get("/members", requireSupabaseIdentity, async (req, res) => {
  const identity = requireVerifiedIdentity(req.identity);
  const user = await ensureUserProfile(identity);
  const access = await getAccessContext(user.id);
  const membership = requireActiveBusiness(access);
  if (
    !access.permissionCodes.includes("employees.read")
  ) {
    throw new HttpError(403, "You do not have permission to view business members.");
  }

  const memberships = await prisma.businessMembership.findMany({
    where: { businessId: membership.businessId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      role: { select: { id: true, code: true, displayName: true } },
      user: { select: { id: true, email: true, fullName: true, status: true } },
    },
  });

  res.json({
    members: memberships.map((membership) => ({
      id: membership.id,
      status: membership.status,
      createdAt: membership.createdAt,
      roleId: membership.role.id,
      role: membership.role.code,
      roleName: membership.role.displayName,
      user: membership.user,
    })),
  });
});

router.delete(
  "/invitations/:invitationId",
  requireSupabaseIdentity,
  async (req, res) => {
    const identity = requireVerifiedIdentity(req.identity);
    const user = await ensureUserProfile(identity);
    const access = await getAccessContext(user.id);
    const membership = requireActiveBusiness(access);
    if (membership.role.code !== "OWNER" || !access.permissionCodes.includes("invitations.manage")) {
      throw new HttpError(403, "Only a business owner can revoke invitations.");
    }

    const invitationId =
      typeof req.params.invitationId === "string" ? req.params.invitationId : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invitationId)) {
      throw new HttpError(400, "invitationId must be a UUID.");
    }

    await prisma.$transaction(async (tx) => {
      const invitation = await tx.businessInvitation.findFirst({
        where: { id: invitationId, businessId: membership.businessId, status: "PENDING" },
      });
      if (!invitation) {
        throw new HttpError(404, "A pending invitation for this business was not found.");
      }
      await tx.businessInvitation.update({ where: { id: invitationId }, data: { status: "REVOKED" } });
      await tx.platformAuditLog.create({
        data: {
          actorUserId: user.id, businessId: membership.businessId,
          action: "membership.invitation.revoke", targetType: "INVITATION", targetId: invitationId,
          changes: { status: { from: "PENDING", to: "REVOKED" } },
        },
      });
    });

    res.status(204).send();
  },
);

router.patch("/members/:membershipId/role", requireSupabaseIdentity, async (req, res) => {
  const identity = requireVerifiedIdentity(req.identity);
  const user = await ensureUserProfile(identity);
  const access = await getAccessContext(user.id);
  const membership = requireActiveBusiness(access);
  if (membership.role.code !== "OWNER" || !access.permissionCodes.includes("business.roles.manage")) {
    throw new HttpError(403, "Only a business owner can change member roles.");
  }
  const membershipId = typeof req.params.membershipId === "string" ? req.params.membershipId : "";
  if (!uuidPattern.test(membershipId)) throw new HttpError(400, "membershipId must be a UUID.");
  const body = readBody(req);
  const roleId = requiredString(body, "roleId", 36);
  if (!uuidPattern.test(roleId)) throw new HttpError(400, "roleId must be a UUID.");
  const reason = readRoleReason(body);
  const [target, nextRole] = await Promise.all([
    prisma.businessMembership.findFirst({
      where: { id: membershipId, businessId: membership.businessId },
      include: { role: { select: { code: true, displayName: true } }, user: { select: { fullName: true } } },
    }),
    prisma.role.findFirst({
      where: { id: roleId, businessId: membership.businessId, scope: "BUSINESS", isArchived: false },
      select: { id: true, code: true, displayName: true },
    }),
  ]);
  if (!target) throw new HttpError(404, "Business membership not found.");
  if (target.role.code === "OWNER") throw new HttpError(409, "The business owner role cannot be changed here.");
  if (!nextRole) throw new HttpError(400, "Select an active role belonging to this business.");
  if (target.roleId === nextRole.id) return res.json({ membership: { id: target.id, roleId: nextRole.id, role: nextRole.code, roleName: nextRole.displayName } });

  const assignedRole = await prisma.$transaction(async (tx) => {
    const activeRole = await tx.role.findFirst({
      where: { id: roleId, businessId: membership.businessId, scope: "BUSINESS", isArchived: false },
      select: { id: true, code: true, displayName: true },
    });
    if (!activeRole) throw new HttpError(409, "The selected business role is no longer available.");
    const updatedMembership = await tx.businessMembership.updateMany({
      where: { id: target.id, businessId: membership.businessId, roleId: target.roleId },
      data: { roleId: activeRole.id },
    });
    if (updatedMembership.count !== 1) throw new HttpError(409, "The membership role was changed by another request.");
    await tx.platformAuditLog.create({
      data: {
        actorUserId: user.id,
        businessId: membership.businessId,
        action: "membership.role.update",
        targetType: "MEMBERSHIP",
        targetId: target.id,
        reason,
        changes: {
          role: { from: target.role.displayName, to: activeRole.displayName },
          user: target.user.fullName,
        },
      },
    });
    return activeRole;
  }, { isolationLevel: "Serializable" });
  res.json({ membership: { id: target.id, roleId: assignedRole.id, role: assignedRole.code, roleName: assignedRole.displayName } });
});

router.patch("/members/:membershipId/status", requireSupabaseIdentity, async (req, res) => {
  const identity = requireVerifiedIdentity(req.identity);
  const user = await ensureUserProfile(identity);
  const access = await getAccessContext(user.id);
  const membership = requireActiveBusiness(access);
  if (
    membership.role.code !== "OWNER" ||
    !access.permissionCodes.includes("business.memberships.manage")
  ) {
    throw new HttpError(403, "Only a business owner can manage business memberships.");
  }

  const membershipId = typeof req.params.membershipId === "string" ? req.params.membershipId : "";
  if (!uuidPattern.test(membershipId)) throw new HttpError(400, "membershipId must be a UUID.");
  const body = readBody(req);
  const status = body.status;
  if (status !== "ACTIVE" && status !== "SUSPENDED" && status !== "INACTIVE") {
    throw new HttpError(400, "status must be ACTIVE, SUSPENDED, or INACTIVE.");
  }
  const reason = requiredString(body, "reason", 1000);
  if (reason.length < 5) throw new HttpError(400, "reason must be at least 5 characters.");

  const target = await prisma.businessMembership.findFirst({
    where: { id: membershipId, businessId: membership.businessId },
    include: { role: true, user: { select: { id: true, fullName: true, email: true } } },
  });
  if (!target) throw new HttpError(404, "Business membership not found.");
  if (target.role.code === "OWNER" || target.role.businessId !== membership.businessId) {
    throw new HttpError(409, "Business owners cannot change another owner's membership status.");
  }
  if (target.status === status) return res.json({ membership: { id: target.id, status } });

  await prisma.$transaction(async (tx) => {
    await tx.businessMembership.update({ where: { id: target.id }, data: { status } });
    await tx.platformAuditLog.create({
      data: {
        actorUserId: user.id, businessId: membership.businessId,
        action: "membership.status.update", targetType: "MEMBERSHIP", targetId: target.id, reason,
        changes: { status: { from: target.status, to: status } },
      },
    });
  });
  res.json({ membership: { id: target.id, status } });
});

router.get("/activity", requireSupabaseIdentity, async (req, res) => {
  const identity = requireVerifiedIdentity(req.identity);
  const user = await ensureUserProfile(identity);
  const access = await getAccessContext(user.id);
  const membership = requireActiveBusiness(access);
  if (!access.permissionCodes.includes("business.audit.read")) {
    throw new HttpError(403, "You do not have permission to view business activity.");
  }
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 20);
  const sort = req.query.sort === undefined ? "newest" : String(req.query.sort);
  const action = typeof req.query.action === "string" ? req.query.action.trim() : "";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new HttpError(400, "page must be positive and pageSize must be between 1 and 100.");
  }
  if (sort !== "newest" && sort !== "oldest") {
    throw new HttpError(400, "sort must be newest or oldest.");
  }
  const parseDate = (value: string, key: string) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new HttpError(400, `${key} must use YYYY-MM-DD format.`);
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new HttpError(400, `${key} must be a valid calendar date.`);
    }
    return date;
  };
  const fromDate = parseDate(from, "from");
  const toDate = parseDate(to, "to");
  if (fromDate && toDate && fromDate > toDate) {
    throw new HttpError(400, "from must be on or before to.");
  }
  const searchConditions: Prisma.PlatformAuditLogWhereInput[] = search
    ? [
      { actor: { fullName: { contains: search, mode: "insensitive" } } },
      { actor: { email: { contains: search, mode: "insensitive" } } },
      { action: { contains: search, mode: "insensitive" } },
      { targetType: { contains: search, mode: "insensitive" } },
      { reason: { contains: search, mode: "insensitive" } },
      ...(uuidPattern.test(search) ? [{ targetId: search }] : []),
    ]
    : [];
  const where: Prisma.PlatformAuditLogWhereInput = {
    businessId: membership.businessId,
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
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: [{ createdAt: sort === "newest" ? "desc" : "asc" }, { id: "desc" }],
      include: { actor: { select: { id: true, email: true, fullName: true } } },
    }),
    prisma.platformAuditLog.findMany({
      where: { businessId: membership.businessId },
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    }),
  ]);
  res.json({ logs, actions: actions.map(({ action: actionName }) => actionName), page, pageSize, total });
});

router.post("/invitations/accept", requireSupabaseIdentity, async (req, res) => {
  const identity = requireVerifiedIdentity(req.identity);
  const body = readBody(req);
  const token = requiredString(body, "token", 128);
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    throw new HttpError(400, "token is invalid.");
  }

  const user = await ensureUserProfile(identity);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const invitation = await prisma.businessInvitation.findUnique({
    where: { tokenHash },
    include: { business: { select: { id: true, name: true, status: true } }, role: true },
  });

  if (!invitation) {
    throw new HttpError(404, "The invitation was not found or has already been removed.");
  }
  if (invitation.status !== "PENDING") {
    throw new HttpError(409, "The invitation is no longer pending.");
  }
  if (invitation.business.status !== "ACTIVE") {
    throw new HttpError(403, "This business is suspended and cannot accept invitations.");
  }
  if (invitation.expiresAt <= new Date()) {
    await prisma.businessInvitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    throw new HttpError(410, "The invitation has expired.");
  }
  if (identity.email !== invitation.invitedEmail) {
    throw new HttpError(403, "Sign in with the email address that received this invitation.");
  }
  const platformAdmin = await prisma.platformUserRole.findFirst({
    where: { userId: user.id, role: { code: "SYSTEM_ADMIN" } },
    select: { userId: true },
  });
  if (platformAdmin) {
    throw new HttpError(409, "System Admin accounts cannot join a business.");
  }
  if (
    invitation.role.scope !== "BUSINESS" ||
    invitation.role.businessId !== invitation.businessId ||
    invitation.role.isArchived ||
    invitation.role.code === "OWNER"
  ) {
    throw new HttpError(409, "This invitation has an invalid employee role.");
  }

  const membership = await prisma.$transaction(async (tx) => {
    const assignedPlatformRole = await tx.platformUserRole.findFirst({
      where: { userId: user.id, role: { code: "SYSTEM_ADMIN" } },
      select: { userId: true },
    });
    if (assignedPlatformRole) {
      throw new HttpError(409, "System Admin accounts cannot join a business.");
    }
    const activeMembership = await tx.businessMembership.findFirst({
      where: { userId: user.id, status: { in: ["ACTIVE", "SUSPENDED"] } },
    });
    if (activeMembership) {
      throw new HttpError(409, "This account already belongs to a business.");
    }
    const previousMembership = await tx.businessMembership.findFirst({
      where: { userId: user.id, businessId: invitation.businessId },
    });

    const claimed = await tx.businessInvitation.updateMany({
      where: {
        id: invitation.id,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
      data: { status: "ACCEPTED", acceptedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new HttpError(409, "The invitation has already been used or expired.");
    }

    const acceptedMembership = previousMembership
      ? await tx.businessMembership.update({
        where: { id: previousMembership.id },
        data: { status: "ACTIVE", roleId: invitation.roleId },
        select: { id: true, businessId: true, roleId: true },
      })
      : await tx.businessMembership.create({
        data: { businessId: invitation.businessId, userId: user.id, roleId: invitation.roleId },
        select: { id: true, businessId: true, roleId: true },
      });
    await tx.platformAuditLog.create({
      data: {
        actorUserId: user.id, businessId: invitation.businessId,
        action: "membership.invitation.accept", targetType: "MEMBERSHIP", targetId: acceptedMembership.id,
        changes: { status: { from: previousMembership?.status ?? null, to: "ACTIVE" } },
      },
    });
    return acceptedMembership;
  }, { isolationLevel: "Serializable" });

  res.status(201).json({
    membership: {
      id: membership.id,
      business: invitation.business,
      role: invitation.role.code,
    },
  });
});

export default router;
