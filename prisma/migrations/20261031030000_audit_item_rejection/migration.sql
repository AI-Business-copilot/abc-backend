-- Owner can reject a submitted audit item and send it back to the employee for a recount.
-- The reason is kept so the employee can see why; it is cleared when the item is submitted again.
ALTER TABLE "stock_audit_items"
ADD COLUMN "rejection_reason" TEXT,
ADD COLUMN "rejected_at" TIMESTAMPTZ(6),
ADD COLUMN "rejected_by" UUID;

ALTER TABLE "stock_audit_items"
ADD CONSTRAINT "fk_stock_audit_items_rejected_by_user_id"
  FOREIGN KEY ("rejected_by")
  REFERENCES "users"("id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;
