import { prisma } from "../infrastructure/database/prisma.client";
import { HttpError } from "../http/http-error";

export async function bootstrapConfiguredSystemAdmin(
  user: { id: string; email: string },
  emailVerified: boolean,
): Promise<void> {
  const configuredEmail = process.env.SYSTEM_ADMIN_EMAIL?.trim().toLowerCase();
  if (!configuredEmail || !emailVerified || user.email !== configuredEmail) {
    return;
  }

  const role = await prisma.role.findUnique({ where: { code: "SYSTEM_ADMIN" } });
  if (!role || role.scope !== "PLATFORM") {
    throw new HttpError(503, "The system administrator role has not been initialized.");
  }

  await prisma.platformUserRole.upsert({
    where: {
      userId_roleId: {
        userId: user.id,
        roleId: role.id,
      },
    },
    create: { userId: user.id, roleId: role.id },
    update: {},
  });
}
