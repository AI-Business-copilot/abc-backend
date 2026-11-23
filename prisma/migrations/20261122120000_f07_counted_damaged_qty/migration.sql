-- F07: broken goods found during a count.
-- The employee counts the usable quantity and the broken quantity separately; the total is
-- derived (usable + broken) and never stored, so it cannot drift.
-- counted_damaged_qty is the broken count. It is added to the balance's damaged_quantity when
-- the audit is applied, on top of the existing damaged bucket.
-- Idempotent where practical so it can be re-run safely on a database that already has part of it.

ALTER TABLE "stock_audit_items"
  ADD COLUMN IF NOT EXISTS "counted_damaged_qty" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "stock_audit_items" DROP CONSTRAINT IF EXISTS "stock_audit_items_counted_damaged_qty_check";
ALTER TABLE "stock_audit_items"
  ADD CONSTRAINT "stock_audit_items_counted_damaged_qty_check"
  CHECK ("counted_damaged_qty" >= 0);
