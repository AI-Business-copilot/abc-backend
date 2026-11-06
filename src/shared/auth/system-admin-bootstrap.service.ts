import { prisma } from "../infrastructure/database/prisma.client";
import { HttpError } from "../http/http-error";

export function isConfiguredSystemAdminEmail(email: string): boolean {
  const configuredEmail = process.env.SYSTEM_ADMIN_EMAIL?.trim().toLowerCase();
  return Boolean(configuredEmail && email.trim().toLowerCase() === configuredEmail);
}

export async function bootstrapConfiguredSystemAdmin(
  user: { id: string; email: string },
  emailVerified: boolean,
): Promise<void> {
  if (!emailVerified || !isConfiguredSystemAdminEmail(user.email)) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    const role = await tx.role.findUnique({ where: { code: "SYSTEM_ADMIN" } });
    if (!role || role.scope !== "PLATFORM") {
      throw new HttpError(503, "The system administrator role has not been initialized.");
    }

    const businessMembership = await tx.businessMembership.findFirst({
      where: { userId: user.id, status: { in: ["ACTIVE", "SUSPENDED"] } },
      select: { id: true },
    });
    if (businessMembership) {
      throw new HttpError(
        409,
        "The configured system administrator account cannot belong to a business. Remove its business membership before continuing.",
      );
    }

    await tx.platformUserRole.upsert({
      where: {
        userId_roleId: {
          userId: user.id,
          roleId: role.id,
        },
      },
      create: { userId: user.id, roleId: role.id },
      update: {},
    });
  }, { isolationLevel: "Serializable" });
}
