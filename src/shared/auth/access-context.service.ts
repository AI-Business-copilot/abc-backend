import { prisma } from "../infrastructure/database/prisma.client";
import { HttpError } from "../http/http-error";

export async function getAccessContext(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberships: {
        where: { status: "ACTIVE" },
        include: {
          business: {
            select: {
              id: true,
              name: true,
              phone: true,
              address: true,
              industryType: true,
              createdAt: true,
            },
          },
          role: {
            include: {
              permissions: { include: { permission: true } },
            },
          },
        },
      },
      platformRoles: {
        include: {
          role: {
            include: {
              permissions: { include: { permission: true } },
            },
          },
        },
      },
    },
  });

  if (!user || !user.isActive) {
    throw new HttpError(403, "This account is not active.");
  }

  const membership = user.memberships[0] ?? null;
  const roles = [
    ...(membership ? [membership.role] : []),
    ...user.platformRoles.map(({ role }) => role),
  ];
  const permissionCodes = [
    ...new Set(
      roles.flatMap((role) =>
        role.permissions.map(({ permission }) => permission.code),
      ),
    ),
  ];

  return {
    user,
    membership,
    platformRoles: user.platformRoles.map(({ role }) => ({
      code: role.code,
      displayName: role.displayName,
    })),
    permissionCodes,
  };
}
