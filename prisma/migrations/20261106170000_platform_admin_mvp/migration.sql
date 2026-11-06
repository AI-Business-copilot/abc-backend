BEGIN;

ALTER TABLE "users" ALTER COLUMN "is_active" DROP DEFAULT;
ALTER TABLE "users" RENAME COLUMN "is_active" TO "status";
ALTER TABLE "users"
  ALTER COLUMN "status" TYPE VARCHAR(20) USING CASE WHEN "status" THEN 'ACTIVE' ELSE 'SUSPENDED' END,
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE',
  ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "users"
  ADD CONSTRAINT "users_status_check" CHECK ("status" IN ('ACTIVE', 'SUSPENDED'));

ALTER TABLE "businesses"
  ADD COLUMN "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  ADD CONSTRAINT "businesses_status_check" CHECK ("status" IN ('ACTIVE', 'SUSPENDED'));

ALTER TABLE "business_memberships"
  DROP CONSTRAINT "business_memberships_status_check",
  ADD CONSTRAINT "business_memberships_status_check"
    CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'INACTIVE'));

DROP INDEX "uq_business_memberships_user";
CREATE UNIQUE INDEX "uq_business_memberships_current_user"
  ON "business_memberships"("user_id")
  WHERE "status" IN ('ACTIVE', 'SUSPENDED');

INSERT INTO "permissions" ("code", "scope", "description")
VALUES
  ('business.memberships.manage', 'BUSINESS', 'Suspend, reactivate, and deactivate business memberships.'),
  ('business.audit.read', 'BUSINESS', 'View activity for the current business.')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" = 'OWNER'
  AND p."code" IN ('business.memberships.manage', 'business.audit.read')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

CREATE TABLE "platform_audit_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "actor_user_id" UUID NOT NULL,
  "business_id" UUID,
  "action" VARCHAR(100) NOT NULL,
  "target_type" VARCHAR(50) NOT NULL,
  "target_id" UUID NOT NULL,
  "changes" JSONB,
  "reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_audit_logs_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "platform_audit_logs_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE INDEX "idx_platform_audit_logs_created_at"
  ON "platform_audit_logs"("created_at" DESC);
CREATE INDEX "idx_platform_audit_logs_business_created_at"
  ON "platform_audit_logs"("business_id", "created_at" DESC);

ALTER TABLE "platform_audit_logs" ENABLE ROW LEVEL SECURITY;

COMMIT;
