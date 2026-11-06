import type { AuthenticatedIdentity } from "./supabase-auth.middleware";
import { prisma } from "../infrastructure/database/prisma.client";
import { HttpError } from "../http/http-error";

export async function ensureUserProfile(identity: AuthenticatedIdentity) {
  if (!identity.email) {
    throw new HttpError(400, "A verified email address is required.");
  }

  const metadataName =
    identity.metadata.full_name ??
    identity.metadata.name ??
    identity.metadata.fullName;
  const fullName =
    typeof metadataName === "string" && metadataName.trim()
      ? metadataName.trim().slice(0, 150)
      : identity.email.slice(0, 150);

  const user = await prisma.user.upsert({
    where: { authUserId: identity.id },
    create: {
      authUserId: identity.id,
      email: identity.email,
      fullName,
    },
    update: {
      email: identity.email,
      fullName,
    },
  });

  if (user.status !== "ACTIVE") {
    throw new HttpError(403, "This account has been suspended.");
  }

  return user;
}
