-- Add F07 audit item-level operations permissions
INSERT INTO "permissions" ("code", "scope", "description")
VALUES
  ('inventory.audit.create', 'BUSINESS', 'Create stock audits.'),
  ('inventory.audit.count', 'BUSINESS', 'Record and submit counted quantities.'),
  ('inventory.audit.submit_item', 'BUSINESS', 'Submit audit items for approval.'),
  ('inventory.audit.approve', 'BUSINESS', 'Approve audits (transition to PENDING_APPROVAL status).'),
  ('inventory.audit.approve_item', 'BUSINESS', 'Approve individual audit items (Owner only).'),
  ('inventory.audit.apply', 'BUSINESS', 'Apply and finalize stock audits.');

-- Grant F07 permissions to OWNER role
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN (
  'inventory.audit.create',
  'inventory.audit.count',
  'inventory.audit.submit_item',
  'inventory.audit.approve',
  'inventory.audit.approve_item',
  'inventory.audit.apply'
)
WHERE r."code" = 'OWNER'
ON CONFLICT DO NOTHING;

-- Grant F07 count+submit permissions to STAFF role
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN (
  'inventory.audit.count',
  'inventory.audit.submit_item'
)
WHERE r."code" = 'STAFF'
ON CONFLICT DO NOTHING;
