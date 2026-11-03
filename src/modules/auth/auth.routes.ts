import { Router } from "express";

import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { getAccessContext } from "../../shared/auth/access-context.service";
import { bootstrapConfiguredSystemAdmin } from "../../shared/auth/system-admin-bootstrap.service";
import { ensureUserProfile } from "../../shared/auth/user-profile.service";
import { HttpError } from "../../shared/http/http-error";

const router = Router();

router.get("/me", requireSupabaseIdentity, async (req, res) => {
  if (!req.identity) {
    throw new HttpError(401, "Authentication is required.");
  }

  const user = await ensureUserProfile(req.identity);
  await bootstrapConfiguredSystemAdmin(user, req.identity.emailVerified);
  const access = await getAccessContext(user.id);

  res.json({
    user: {
      id: access.user.id,
      email: access.user.email,
      fullName: access.user.fullName,
      emailVerified: req.identity.emailVerified,
    },
    business: access.membership
      ? {
        id: access.membership.business.id,
        name: access.membership.business.name,
        phone: access.membership.business.phone,
        address: access.membership.business.address,
        industryType: access.membership.business.industryType,
        createdAt: access.membership.business.createdAt,
        role: access.membership.role.code,
      }
      : null,
    platformRoles: access.platformRoles,
    permissions: access.permissionCodes,
    onboardingRequired:
      !access.membership && access.platformRoles.length === 0,
  });
});

export default router;
