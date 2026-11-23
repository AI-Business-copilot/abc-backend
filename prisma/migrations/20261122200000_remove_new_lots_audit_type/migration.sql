-- The "lô mới" (NEW_LOTS) audit type is removed. Every audit row now counts a lot that is
-- already in the system, so:
--   - stock_audits.audit_type always holds RE_AUDIT
--   - stock_audit_items.lot_mode is dropped: the row's lot is the lot item it points at
-- Idempotent so it can be re-run safely on a database that already has part of it.

-- Existing new-lot audits cannot point at an existing lot item, so they have nothing to count.
-- They are cancelled rather than left in a state the application no longer supports.
UPDATE "stock_audits"
  SET "status" = 'CANCELLED', "completed_at" = now()
  WHERE "audit_type" = 'NEW_LOTS' AND "status" IN ('IN_PROGRESS', 'PENDING_APPROVAL');

-- The old CHECK constraint only allows NEW_LOTS and RE_AUDIT, so it has to go before the
-- remaining rows are remapped.
ALTER TABLE "stock_audits" DROP CONSTRAINT IF EXISTS "chk_audit_type";

UPDATE "stock_audits" SET "audit_type" = 'RE_AUDIT' WHERE "audit_type" <> 'RE_AUDIT';

ALTER TABLE "stock_audits" ALTER COLUMN "audit_type" SET DEFAULT 'RE_AUDIT';

ALTER TABLE "stock_audit_items" DROP COLUMN IF EXISTS "lot_mode";
