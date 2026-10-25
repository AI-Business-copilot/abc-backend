BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "users" LIMIT 1) THEN
    RAISE EXCEPTION
      'Cannot replace the legacy users authentication columns while users exist. Export and map existing accounts to Supabase Auth before applying this migration.';
  END IF;
END;
$$;

ALTER TABLE "users"
  DROP CONSTRAINT "users_business_id_fkey";

DROP INDEX "uq_user_tenant_username";

ALTER TABLE "users"
  DROP COLUMN "business_id",
  DROP COLUMN "username",
  DROP COLUMN "password_hash",
  DROP COLUMN "role",
  ADD COLUMN "auth_user_id" UUID NOT NULL,
  ADD COLUMN "email" VARCHAR(320) NOT NULL,
  ADD CONSTRAINT "users_email_lowercase_check" CHECK ("email" = LOWER("email"));

CREATE UNIQUE INDEX "uq_users_auth_user_id" ON "users"("auth_user_id");
CREATE UNIQUE INDEX "uq_users_email" ON "users"("email");

CREATE TABLE "roles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(50) NOT NULL,
  "scope" VARCHAR(20) NOT NULL,
  "display_name" VARCHAR(100) NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "roles_scope_check" CHECK ("scope" IN ('BUSINESS', 'PLATFORM'))
);

CREATE UNIQUE INDEX "uq_roles_code" ON "roles"("code");

CREATE TABLE "permissions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(100) NOT NULL,
  "scope" VARCHAR(20) NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "permissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "permissions_scope_check" CHECK ("scope" IN ('BUSINESS', 'PLATFORM'))
);

CREATE UNIQUE INDEX "uq_permissions_code" ON "permissions"("code");

CREATE TABLE "role_permissions" (
  "role_id" UUID NOT NULL,
  "permission_id" UUID NOT NULL,

  CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id"),
  CONSTRAINT "role_permissions_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "role_permissions_permission_id_fkey"
    FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE "business_memberships" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "business_memberships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_memberships_status_check" CHECK ("status" IN ('ACTIVE', 'SUSPENDED')),
  CONSTRAINT "business_memberships_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "business_memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "business_memberships_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "uq_business_memberships_user" ON "business_memberships"("user_id");
CREATE UNIQUE INDEX "uq_business_memberships_business_user" ON "business_memberships"("business_id", "user_id");
CREATE INDEX "idx_business_memberships_business_status" ON "business_memberships"("business_id", "status");

CREATE TABLE "platform_user_roles" (
  "user_id" UUID NOT NULL,
  "role_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_user_roles_pkey" PRIMARY KEY ("user_id", "role_id"),
  CONSTRAINT "platform_user_roles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "platform_user_roles_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE TABLE "business_invitations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "invited_email" VARCHAR(320) NOT NULL,
  "role_id" UUID NOT NULL,
  "invited_by" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "email_status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "accepted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "business_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_invitations_status_check"
    CHECK ("status" IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED', 'FAILED')),
  CONSTRAINT "business_invitations_email_status_check"
    CHECK ("email_status" IN ('PENDING', 'SENT', 'FAILED')),
  CONSTRAINT "business_invitations_email_lowercase_check"
    CHECK ("invited_email" = LOWER("invited_email")),
  CONSTRAINT "business_invitations_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "business_invitations_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "business_invitations_invited_by_fkey"
    FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "uq_business_invitations_token_hash" ON "business_invitations"("token_hash");
CREATE UNIQUE INDEX "uq_business_invitations_pending_email"
  ON "business_invitations"("business_id", "invited_email")
  WHERE "status" = 'PENDING';
CREATE INDEX "idx_business_invitations_business_status"
  ON "business_invitations"("business_id", "status");
CREATE INDEX "idx_business_invitations_email_status"
  ON "business_invitations"("invited_email", "status");

INSERT INTO "roles" ("code", "scope", "display_name", "description")
VALUES
  ('OWNER', 'BUSINESS', 'Business Owner', 'Manages one business and its employees.'),
  ('STAFF', 'BUSINESS', 'Store Employee', 'Performs permitted day-to-day store operations.'),
  ('SYSTEM_ADMIN', 'PLATFORM', 'System Administrator', 'Manages platform-level operations.');

INSERT INTO "permissions" ("code", "scope", "description")
VALUES
  ('business.read', 'BUSINESS', 'View business information.'),
  ('business.update', 'BUSINESS', 'Update business information and settings.'),
  ('employees.read', 'BUSINESS', 'View business employees.'),
  ('employees.manage', 'BUSINESS', 'Invite, update, and deactivate employees.'),
  ('invitations.manage', 'BUSINESS', 'Create and revoke employee invitations.'),
  ('products.read', 'BUSINESS', 'View products and prices.'),
  ('products.manage', 'BUSINESS', 'Create and update products and pricing.'),
  ('inventory.read', 'BUSINESS', 'View inventory and inventory history.'),
  ('inventory.receive', 'BUSINESS', 'Record incoming inventory.'),
  ('inventory.adjust', 'BUSINESS', 'Adjust inventory quantities.'),
  ('orders.read', 'BUSINESS', 'View sales orders.'),
  ('orders.create', 'BUSINESS', 'Create sales orders.'),
  ('finance.read', 'BUSINESS', 'View sensitive financial information.'),
  ('analytics.read', 'BUSINESS', 'View business analytics.'),
  ('copilot.use', 'BUSINESS', 'Use business analysis tools.'),
  ('platform.users.manage', 'PLATFORM', 'Manage platform user accounts.'),
  ('platform.businesses.manage', 'PLATFORM', 'Manage registered businesses.'),
  ('platform.roles.manage', 'PLATFORM', 'Manage platform roles and permissions.'),
  ('platform.audit.read', 'PLATFORM', 'View platform audit information.'),
  ('platform.settings.manage', 'PLATFORM', 'Manage shared platform settings.');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."scope" = 'BUSINESS'
WHERE r."code" = 'OWNER';

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p
  ON p."code" IN (
    'business.read',
    'employees.read',
    'products.read',
    'inventory.read',
    'inventory.receive',
    'inventory.adjust',
    'orders.read',
    'orders.create'
  )
WHERE r."code" = 'STAFF';

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."scope" = 'PLATFORM'
WHERE r."code" = 'SYSTEM_ADMIN';

COMMIT;
