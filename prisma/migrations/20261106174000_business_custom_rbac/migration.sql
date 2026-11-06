BEGIN;

ALTER TABLE "roles"
  ADD COLUMN "business_id" UUID,
  ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "is_archived" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT "roles_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "uq_roles_business_display_name"
  ON "roles"("business_id", "display_name");
CREATE INDEX "idx_roles_business_scope_archived"
  ON "roles"("business_id", "scope", "is_archived");

INSERT INTO "roles" (
  "id", "code", "scope", "display_name", "description", "business_id", "is_default"
)
SELECT
  gen_random_uuid(),
  'BIZ_' || REPLACE(b."id"::text, '-', ''),
  'BUSINESS',
  'Nhân viên cửa hàng',
  'Vai trò nhân viên mặc định. Quyền khởi tạo được sao chép từ vai trò STAFF hiện có.',
  b."id",
  TRUE
FROM "businesses" b
WHERE EXISTS (SELECT 1 FROM "roles" WHERE "code" = 'STAFF');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT business_staff."id", rp."permission_id"
FROM "roles" business_staff
CROSS JOIN "roles" staff_template
JOIN "role_permissions" rp ON rp."role_id" = staff_template."id"
WHERE business_staff."is_default" = TRUE
  AND staff_template."code" = 'STAFF';

UPDATE "business_memberships" membership
SET "role_id" = (
  SELECT business_staff."id"
  FROM "roles" business_staff
  WHERE business_staff."business_id" = membership."business_id"
    AND business_staff."is_default" = TRUE
)
WHERE membership."role_id" = (SELECT "id" FROM "roles" WHERE "code" = 'STAFF');

UPDATE "business_invitations" invitation
SET "role_id" = (
  SELECT business_staff."id"
  FROM "roles" business_staff
  WHERE business_staff."business_id" = invitation."business_id"
    AND business_staff."is_default" = TRUE
)
WHERE invitation."role_id" = (SELECT "id" FROM "roles" WHERE "code" = 'STAFF');

UPDATE "roles" SET "is_archived" = TRUE WHERE "code" = 'STAFF';

INSERT INTO "permissions" ("code", "scope", "description")
VALUES
  ('business.roles.manage', 'BUSINESS', 'Create and manage business roles and employee permissions.'),
  ('vendor_returns.create', 'BUSINESS', 'Create vendor return requests.')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" = 'OWNER'
  AND p."code" IN ('business.roles.manage', 'vendor_returns.create')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

COMMIT;
