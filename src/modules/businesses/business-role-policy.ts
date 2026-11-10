export const RESERVED_BUSINESS_ROLE_PERMISSION_CODES = new Set([
  "business.roles.manage",
  "business.update",
  "employees.manage",
  "invitations.manage",
  "business.memberships.manage",
  "business.audit.read",
  "inventory.audit.approve_item",
  "inventory.scrap.approve",
]);

export function isAssignableBusinessPermission(permission: { code: string; scope: string }) {
  return (
    permission.scope === "BUSINESS" &&
    !RESERVED_BUSINESS_ROLE_PERMISSION_CODES.has(permission.code)
  );
}
