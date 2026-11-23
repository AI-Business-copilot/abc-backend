-- F07: the history of a stock audit row.
--
-- When the owner approves, rejects or asks for another count, the row is recorded here. The
-- record is a copy of the numbers as they were at that moment, not a link to the live row, so
-- the history stays what it was even after the live row changes.
--
-- stock_audit_item_history_counts holds what each counter had found at that moment. Without it
-- the history would only say that the row was sent back, not what the two people had counted.
--
-- The evidence photos are filed under the history entry too: history_id is set and archived_at
-- marks them as no longer part of the live gallery. count_id stays, so the photos keep their
-- owner (who may read them), keep their place in the delete cascade and keep their files
-- collected when a draft is removed.
--
-- Idempotent so it can be re-run safely on a database that already has part of it.

CREATE TABLE IF NOT EXISTS "stock_audit_item_histories" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "item_id" UUID NOT NULL,
  "audit_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" VARCHAR(30) NOT NULL,
  "reason" TEXT,
  "actor_id" UUID NOT NULL,
  "snapshot_qty" INTEGER NOT NULL,
  "counted_qty" INTEGER NOT NULL,
  "counted_damaged_qty" INTEGER NOT NULL,
  "discrepancy_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stock_audit_item_histories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_audit_item_histories_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "stock_audit_item_histories_counted_qty_check" CHECK ("counted_qty" >= 0),
  CONSTRAINT "stock_audit_item_histories_counted_damaged_qty_check" CHECK ("counted_damaged_qty" >= 0),
  CONSTRAINT "stock_audit_item_histories_action_check"
    CHECK ("action" IN ('APPROVED', 'REJECTED', 'RECOUNT')),
  CONSTRAINT "stock_audit_item_histories_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "stock_audit_item_histories_item_id_fkey"
    FOREIGN KEY ("item_id") REFERENCES "stock_audit_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "stock_audit_item_histories_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_stock_audit_item_histories_item_revision"
  ON "stock_audit_item_histories" ("item_id", "revision");

CREATE INDEX IF NOT EXISTS "idx_stock_audit_item_histories_business_item"
  ON "stock_audit_item_histories" ("business_id", "item_id");

CREATE TABLE IF NOT EXISTS "stock_audit_item_history_counts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "history_id" UUID NOT NULL,
  "counter_user_id" UUID NOT NULL,
  "counted_qty" INTEGER NOT NULL,
  "counted_damaged_qty" INTEGER NOT NULL,
  "discrepancy_reason" TEXT,
  "submitted_at" TIMESTAMPTZ(6),

  CONSTRAINT "stock_audit_item_history_counts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_audit_item_history_counts_counted_qty_check" CHECK ("counted_qty" >= 0),
  CONSTRAINT "stock_audit_item_history_counts_counted_damaged_qty_check" CHECK ("counted_damaged_qty" >= 0),
  CONSTRAINT "stock_audit_item_history_counts_history_id_fkey"
    FOREIGN KEY ("history_id") REFERENCES "stock_audit_item_histories"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "stock_audit_item_history_counts_counter_user_id_fkey"
    FOREIGN KEY ("counter_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_stock_audit_item_history_counts_history"
  ON "stock_audit_item_history_counts" ("history_id");

-- The photo is filed under a history entry once the row is approved, rejected or sent back.
ALTER TABLE "stock_audit_item_count_images"
  ADD COLUMN IF NOT EXISTS "history_id" UUID;
ALTER TABLE "stock_audit_item_count_images"
  ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ(6);

ALTER TABLE "stock_audit_item_count_images" DROP CONSTRAINT IF EXISTS "stock_audit_item_count_images_history_id_fkey";
ALTER TABLE "stock_audit_item_count_images"
  ADD CONSTRAINT "stock_audit_item_count_images_history_id_fkey"
  FOREIGN KEY ("history_id") REFERENCES "stock_audit_item_histories"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE INDEX IF NOT EXISTS "idx_stock_audit_item_count_images_history"
  ON "stock_audit_item_count_images" ("history_id");

-- Only the backend (service role) reads or writes these tables; no client policies are created.
ALTER TABLE "stock_audit_item_histories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_audit_item_history_counts" ENABLE ROW LEVEL SECURITY;
