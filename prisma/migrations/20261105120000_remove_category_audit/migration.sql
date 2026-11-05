-- Remove the CATEGORY_AUDIT mode; audits are now either NEW_LOTS or RE_AUDIT.
-- Apply logic treats every non-RE_AUDIT type the same, so legacy rows are remapped to NEW_LOTS.
-- This migration is idempotent (same style as 20261031040000_fix_lot_status_constraint).

ALTER TABLE "stock_audits" DROP CONSTRAINT IF EXISTS "chk_audit_type";

UPDATE "stock_audits" SET "audit_type" = 'NEW_LOTS' WHERE "audit_type" = 'CATEGORY_AUDIT';

ALTER TABLE "stock_audits"
ADD CONSTRAINT "chk_audit_type"
  CHECK ("audit_type" IN ('NEW_LOTS', 'RE_AUDIT'));

ALTER TABLE "stock_audits" ALTER COLUMN "audit_type" SET DEFAULT 'NEW_LOTS';
