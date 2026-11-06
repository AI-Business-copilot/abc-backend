-- F08: quarantine details, scrap order approval workflow and scrap order evidence images.
-- Idempotent where practical so it can be re-run safely on a database that already has part of it.

-- 1. Quarantine details on product_lots
ALTER TABLE "product_lots"
  ADD COLUMN IF NOT EXISTS "quarantine_qty" INTEGER,
  ADD COLUMN IF NOT EXISTS "quarantined_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "quarantined_by" UUID,
  ADD COLUMN IF NOT EXISTS "quarantine_note" VARCHAR(500);

ALTER TABLE "product_lots" DROP CONSTRAINT IF EXISTS "product_lots_quarantine_qty_check";
ALTER TABLE "product_lots"
  ADD CONSTRAINT "product_lots_quarantine_qty_check"
  CHECK ("quarantine_qty" IS NULL OR "quarantine_qty" > 0);

ALTER TABLE "product_lots" DROP CONSTRAINT IF EXISTS "product_lots_quarantined_by_fkey";
ALTER TABLE "product_lots"
  ADD CONSTRAINT "product_lots_quarantined_by_fkey"
  FOREIGN KEY ("quarantined_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 2. Approval / rejection audit fields on scrap_orders
ALTER TABLE "scrap_orders"
  ADD COLUMN IF NOT EXISTS "approved_by" UUID,
  ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "rejected_by" UUID,
  ADD COLUMN IF NOT EXISTS "rejected_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "rejection_reason_code" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "rejection_note" VARCHAR(500);

ALTER TABLE "scrap_orders" DROP CONSTRAINT IF EXISTS "scrap_orders_approved_by_fkey";
ALTER TABLE "scrap_orders"
  ADD CONSTRAINT "scrap_orders_approved_by_fkey"
  FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "scrap_orders" DROP CONSTRAINT IF EXISTS "scrap_orders_rejected_by_fkey";
ALTER TABLE "scrap_orders"
  ADD CONSTRAINT "scrap_orders_rejected_by_fkey"
  FOREIGN KEY ("rejected_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "scrap_orders" DROP CONSTRAINT IF EXISTS "scrap_orders_rejection_reason_code_check";
ALTER TABLE "scrap_orders"
  ADD CONSTRAINT "scrap_orders_rejection_reason_code_check"
  CHECK ("rejection_reason_code" IS NULL
    OR "rejection_reason_code" IN ('WRONG_QUANTITY', 'PHOTO_UNCLEAR', 'NOT_REMOVED_FROM_SHELF', 'OTHER'));

-- 3. scrap_orders.status: DRAFT becomes PENDING. The old constraint name is not known for every
-- database, so drop any CHECK constraint on scrap_orders that mentions "status" before the UPDATE.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'scrap_orders'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE "scrap_orders" DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

UPDATE "scrap_orders" SET "status" = 'PENDING' WHERE "status" = 'DRAFT';

ALTER TABLE "scrap_orders"
  ADD CONSTRAINT "scrap_orders_status_check"
  CHECK ("status" IN ('PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED'));

ALTER TABLE "scrap_orders" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- One open (PENDING) scrap order per lot.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_scrap_orders_one_pending_per_lot"
  ON "scrap_orders" ("lot_id")
  WHERE "status" = 'PENDING' AND "lot_id" IS NOT NULL;

-- 4. Scrap order evidence images (soft delete keeps the audit trail)
CREATE TABLE IF NOT EXISTS "scrap_order_images" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "scrap_order_id" UUID NOT NULL,
  "storage_path" VARCHAR(500) NOT NULL,
  "mime_type" VARCHAR(50) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "note" VARCHAR(500),
  "uploaded_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(6),
  "deleted_by" UUID,

  CONSTRAINT "scrap_order_images_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scrap_order_images_size_bytes_check" CHECK ("size_bytes" > 0),
  CONSTRAINT "scrap_order_images_mime_type_check" CHECK ("mime_type" IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT "scrap_order_images_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "scrap_order_images_scrap_order_id_fkey"
    FOREIGN KEY ("scrap_order_id") REFERENCES "scrap_orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "scrap_order_images_uploaded_by_fkey"
    FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "scrap_order_images_deleted_by_fkey"
    FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_scrap_order_images_order"
  ON "scrap_order_images" ("business_id", "scrap_order_id");

-- Only the backend (service role) reads or writes this table; no client policies are created.
ALTER TABLE "scrap_order_images" ENABLE ROW LEVEL SECURITY;
