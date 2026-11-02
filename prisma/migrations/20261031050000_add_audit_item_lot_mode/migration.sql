-- The owner decides what the employee counts on each audit item:
--   EXISTING: a lot already in the system (the employee picks it and may correct its dates)
--   NEW:      a lot that does not exist yet (the employee types the number and dates)
-- The employee cannot switch between the two; the backend enforces it when saving a count.
ALTER TABLE "stock_audit_items" ADD COLUMN "lot_mode" VARCHAR(20) NOT NULL DEFAULT 'EXISTING';

-- Rows where the employee already typed a new lot keep working as NEW.
UPDATE "stock_audit_items"
SET "lot_mode" = 'NEW'
WHERE "lot_id" IS NULL AND "lot_number" IS NOT NULL;

ALTER TABLE "stock_audit_items"
ADD CONSTRAINT "stock_audit_items_lot_mode_check"
  CHECK ("lot_mode" IN ('EXISTING', 'NEW'));
