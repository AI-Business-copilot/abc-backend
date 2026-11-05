-- The audit service writes status = 'DONE' in two places: approveAudit (bulk owner action) and
-- applyAudit (after the last item is approved). DONE is listed first as the terminal status.
-- An older definition may exist without it, so the constraint is rebuilt rather than added blindly.
DO $$
BEGIN
  IF to_regclass('public.stock_audits') IS NULL THEN
    RAISE NOTICE 'stock_audits does not exist; skipped chk_audit_status. Re-run after the base tables are created.';
  ELSE
    ALTER TABLE "stock_audits" DROP CONSTRAINT IF EXISTS "chk_audit_status";

    ALTER TABLE "stock_audits"
    ADD CONSTRAINT "chk_audit_status"
      CHECK ("status" IN ('DONE', 'IN_PROGRESS', 'PENDING_APPROVAL', 'APPLIED', 'CANCELLED'));
  END IF;
END $$;
