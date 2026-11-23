-- F07: dual counting (two employees count the same row independently).
--
-- The owner assigns a second employee to a row with second_counter_user_id. Each employee's own
-- count lives in stock_audit_item_counts, one row per (item, counter). Keeping the counts in a
-- separate table is what makes the count blind: an employee reads only their own row and never
-- the other counter's number.
--
-- stock_audit_items.counted_qty stays the owner's agreed figure for the row:
--   - one counter only  -> the single count, as before
--   - two counters agree -> that shared number, ready for the owner to approve
--   - two counters differ -> the row waits for the owner to send it back for a recount
--
-- Idempotent where practical so it can be re-run safely on a database that already has part of it.

ALTER TABLE "stock_audit_items"
  ADD COLUMN IF NOT EXISTS "second_counter_user_id" UUID;

ALTER TABLE "stock_audit_items" DROP CONSTRAINT IF EXISTS "stock_audit_items_second_counter_user_id_fkey";
ALTER TABLE "stock_audit_items"
  ADD CONSTRAINT "stock_audit_items_second_counter_user_id_fkey"
  FOREIGN KEY ("second_counter_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE IF NOT EXISTS "stock_audit_item_counts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "item_id" UUID NOT NULL,
  "counter_user_id" UUID NOT NULL,
  "counted_qty" INTEGER NOT NULL DEFAULT 0,
  "counted_damaged_qty" INTEGER NOT NULL DEFAULT 0,
  "discrepancy_reason" TEXT,
  "new_lot_expiration_date" DATE,
  "new_lot_manufacturing_date" DATE,
  "submitted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pk_stock_audit_item_counts" PRIMARY KEY ("id"),
  CONSTRAINT "stock_audit_item_counts_counted_qty_check" CHECK ("counted_qty" >= 0),
  CONSTRAINT "stock_audit_item_counts_counted_damaged_qty_check" CHECK ("counted_damaged_qty" >= 0)
);

ALTER TABLE "stock_audit_item_counts" DROP CONSTRAINT IF EXISTS "stock_audit_item_counts_item_id_fkey";
ALTER TABLE "stock_audit_item_counts"
  ADD CONSTRAINT "stock_audit_item_counts_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "stock_audit_items"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "stock_audit_item_counts" DROP CONSTRAINT IF EXISTS "stock_audit_item_counts_counter_user_id_fkey";
ALTER TABLE "stock_audit_item_counts"
  ADD CONSTRAINT "stock_audit_item_counts_counter_user_id_fkey"
  FOREIGN KEY ("counter_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_stock_audit_item_counts_item_counter"
  ON "stock_audit_item_counts"("item_id", "counter_user_id");

CREATE INDEX IF NOT EXISTS "idx_stock_audit_item_counts_item"
  ON "stock_audit_item_counts"("item_id");

-- Rows that already existed keep their single count. Move it into the new table so an existing
-- in-progress audit is not left with an empty count list.
-- stock_audit_items has no created_at / updated_at columns, so the target table's own defaults
-- fill the new row's timestamps.
INSERT INTO "stock_audit_item_counts"
  ("item_id", "counter_user_id", "counted_qty", "counted_damaged_qty", "discrepancy_reason",
   "new_lot_expiration_date", "new_lot_manufacturing_date", "submitted_at")
SELECT
  i."id", i."assigned_to_user_id", i."counted_qty", i."counted_damaged_qty", i."discrepancy_reason",
  i."new_lot_expiration_date", i."new_lot_manufacturing_date", i."submitted_at"
FROM "stock_audit_items" i
WHERE i."assigned_to_user_id" IS NOT NULL
  AND i."counted_qty" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "stock_audit_item_counts" c
    WHERE c."item_id" = i."id" AND c."counter_user_id" = i."assigned_to_user_id"
  );
