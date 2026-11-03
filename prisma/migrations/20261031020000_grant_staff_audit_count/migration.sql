-- Grant STAFF the permissions to count and submit audit items.
-- The same grant exists in 20261029124324_add_f07_item_level_workflow/migration_permissions.sql,
-- but Prisma only runs files named migration.sql, so it was never applied.
-- Idempotent: safe to run when the rows already exist.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN (
  'inventory.audit.count',
  'inventory.audit.submit_item'
)
WHERE r."code" = 'STAFF'
ON CONFLICT DO NOTHING;
