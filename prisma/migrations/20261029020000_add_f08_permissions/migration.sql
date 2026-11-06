-- Add F08 permissions for lot tracking and scrap management
INSERT INTO "permissions" ("code", "scope", "description")
VALUES
  ('inventory.lot.read', 'BUSINESS', 'View lots and expiry information.'),
  ('inventory.scrap.create', 'BUSINESS', 'Create and manage scrap orders.'),
  ('inventory.scrap.approve', 'BUSINESS', 'Approve scrap orders (Owner only).');

-- Grant F08 permissions to OWNER role
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN ('inventory.lot.read', 'inventory.scrap.create', 'inventory.scrap.approve')
WHERE r."code" = 'OWNER';

-- Grant read-only F08 permissions to STAFF role
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN ('inventory.lot.read', 'inventory.scrap.create')
WHERE r."code" = 'STAFF';
