-- F08: cancel attribution on scrap_orders.
-- A cancelled order keeps its photos and leaves the lot item QUARANTINED, so only the
-- status and the three audit columns change. The status CHECK already allows CANCELLED
-- and the one-PENDING-per-lot-item index only covers PENDING, so nothing else is needed.
-- Idempotent where practical so it can be re-run safely on a database that already has part of it.

ALTER TABLE "scrap_orders"
  ADD COLUMN IF NOT EXISTS "cancelled_by" UUID,
  ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "cancelled_note" VARCHAR(500);

ALTER TABLE "scrap_orders" DROP CONSTRAINT IF EXISTS "scrap_orders_cancelled_by_fkey";
ALTER TABLE "scrap_orders"
  ADD CONSTRAINT "scrap_orders_cancelled_by_fkey"
  FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
