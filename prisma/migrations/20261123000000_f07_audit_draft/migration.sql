-- F07: a draft phase for stock audits.
--
-- An audit used to be created directly as IN_PROGRESS, which locked the SKUs right away and
-- left the owner no way to undo a misconfigured audit. The owner now prepares a DRAFT, which
-- locks nothing and can still be deleted, and starts the counting explicitly. An audit that is
-- already running can only be cancelled, never deleted.
--
-- Idempotent so it can be re-run safely on a database that already has part of it.

-- The count has not started in a draft, so the start date is written when the audit starts.
ALTER TABLE "stock_audits" ALTER COLUMN "count_start_at" DROP NOT NULL;

-- A draft locks nothing; the SKUs are locked when the counting starts.
ALTER TABLE "stock_audits" ALTER COLUMN "is_locked_for_audit" SET DEFAULT false;
ALTER TABLE "stock_audits" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- An older definition may exist without DRAFT, so the constraint is rebuilt rather than added blindly.
ALTER TABLE "stock_audits" DROP CONSTRAINT IF EXISTS "chk_audit_status";

ALTER TABLE "stock_audits"
  ADD CONSTRAINT "chk_audit_status"
    CHECK ("status" IN ('DRAFT', 'DONE', 'IN_PROGRESS', 'PENDING_APPROVAL', 'APPLIED', 'CANCELLED'));
