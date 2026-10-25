import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";

import { getAccessContext } from "../../shared/auth/access-context.service";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { ensureUserProfile } from "../../shared/auth/user-profile.service";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";

const router = Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const existingMembership = await prisma.businessMembership.findUnique({
    where: { userId: user.id },
  });
  if (existingMembership) {
    throw new HttpError(409, "This account already belongs to a business.");
  }

  const ownerRole = await prisma.role.findUnique({ where: { code: "OWNER" } });
  if (!ownerRole || ownerRole.scope !== "BUSINESS") {
    throw new HttpError(503, "The business owner role has not been initialized.");
  }

  const business = await prisma.business.create({
    data: {
      name,
      phone,
      industryType,
      address,
      memberships: {
        create: {
          userId: user.id,
          roleId: ownerRole.id,
        },
      },
    },
    select: { id: true, name: true, phone: true, industryType: true, address: true },
  });

  res.status(201).json({
    business,
    role: ownerRole.code,
  });
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
  if (
    !access.membership ||
    access.membership.role.code !== "OWNER" ||
    !access.permissionCodes.includes("invitations.manage")
  ) {
    throw new HttpError(403, "Only a business owner can invite employees.");
  }

  const invitationAuthConfig = getInvitationAuthConfig();
  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    include: { memberships: true },
  });
  if (existingUser?.memberships.length) {
    throw new HttpError(409, "This account already belongs to a business.");
  }

  const now = new Date();
  await prisma.businessInvitation.updateMany({
    where: {
      businessId: access.membership.businessId,
      invitedEmail: email,
      status: "PENDING",
      expiresAt: { lte: now },
    },
    data: { status: "EXPIRED" },
  });

  const pendingInvitation = await prisma.businessInvitation.findFirst({
    where: {
      businessId: access.membership.businessId,
      invitedEmail: email,
      status: "PENDING",
    },
  });
  if (pendingInvitation) {
    throw new HttpError(409, "A pending invitation already exists for this email.");
  }

  const staffRole = await prisma.role.findUnique({ where: { code: "STAFF" } });
  if (!staffRole || staffRole.scope !== "BUSINESS") {
    throw new HttpError(503, "The store employee role has not been initialized.");
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const invitation = await prisma.businessInvitation.create({
    data: {
      businessId: access.membership.businessId,
      invitedEmail: email,
      roleId: staffRole.id,
      invitedBy: user.id,
      tokenHash,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    },
    select: { id: true, invitedEmail: true, expiresAt: true },
  });

  try {
    await sendSupabaseInvitation(email, invitation.id, token, invitationAuthConfig);
  } catch (error) {
    await prisma.businessInvitation.update({
      where: { id: invitation.id },
      data: { status: "FAILED", emailStatus: "FAILED" },
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
      role: staffRole.code,
      expiresAt: invitation.expiresAt,
      emailStatus: "SENT",
    },
  });
});

router.get("/invitations", requireSupabaseIdentity, async (req, res) => {
  const identity = requireVerifiedIdentity(req.identity);
  const user = await ensureUserProfile(identity);
  const access = await getAccessContext(user.id);
  if (
    !access.membership ||
    access.membership.role.code !== "OWNER" ||
    !access.permissionCodes.includes("invitations.manage")
  ) {
    throw new HttpError(403, "Only a business owner can view invitations.");
  }

  const invitations = await prisma.businessInvitation.findMany({
    where: { businessId: access.membership.businessId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      invitedEmail: true,
      status: true,
      emailStatus: true,
      expiresAt: true,
      createdAt: true,
      role: { select: { code: true } },
    },
  });

  res.json({
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.invitedEmail,
      role: invitation.role.code,
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
  if (
    !access.membership ||
    !access.permissionCodes.includes("employees.read")
  ) {
    throw new HttpError(403, "You do not have permission to view business members.");
  }

  const memberships = await prisma.businessMembership.findMany({
    where: { businessId: access.membership.businessId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      role: { select: { code: true, displayName: true } },
      user: { select: { id: true, email: true, fullName: true } },
    },
  });

  res.json({
    members: memberships.map((membership) => ({
      id: membership.id,
      status: membership.status,
      createdAt: membership.createdAt,
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
    if (
      !access.membership ||
      access.membership.role.code !== "OWNER" ||
      !access.permissionCodes.includes("invitations.manage")
    ) {
      throw new HttpError(403, "Only a business owner can revoke invitations.");
    }

    const invitationId =
      typeof req.params.invitationId === "string" ? req.params.invitationId : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invitationId)) {
      throw new HttpError(400, "invitationId must be a UUID.");
    }

    const result = await prisma.businessInvitation.updateMany({
      where: {
        id: invitationId,
        businessId: access.membership.businessId,
        status: "PENDING",
      },
      data: { status: "REVOKED" },
    });
    if (result.count !== 1) {
      throw new HttpError(404, "A pending invitation for this business was not found.");
    }

    res.status(204).send();
  },
);

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
    include: { business: { select: { id: true, name: true } }, role: true },
  });

  if (!invitation) {
    throw new HttpError(404, "The invitation was not found or has already been removed.");
  }
  if (invitation.status !== "PENDING") {
    throw new HttpError(409, "The invitation is no longer pending.");
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
  if (invitation.role.code !== "STAFF" || invitation.role.scope !== "BUSINESS") {
    throw new HttpError(409, "This invitation has an invalid employee role.");
  }

  const membership = await prisma.$transaction(async (tx) => {
    const existingMembership = await tx.businessMembership.findUnique({
      where: { userId: user.id },
    });
    if (existingMembership) {
      throw new HttpError(409, "This account already belongs to a business.");
    }

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

    return tx.businessMembership.create({
      data: {
        businessId: invitation.businessId,
        userId: user.id,
        roleId: invitation.roleId,
      },
      select: { id: true, businessId: true, roleId: true },
    });
  });

  res.status(201).json({
    membership: {
      id: membership.id,
      business: invitation.business,
      role: invitation.role.code,
    },
  });
});

export default router;
