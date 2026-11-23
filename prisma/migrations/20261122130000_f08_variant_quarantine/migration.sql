-- F08: variant-level quarantine.
-- A product that has no lot item (clothes) cannot use product_lot_items.quarantine_qty, because
-- there is no lot item to hold that state. This table holds the same information for a variant,
-- so broken goods can be quarantined and then scrapped.
-- One quarantine row per variant per business: the quantity is increased or decreased in place.
-- Idempotent where practical so it can be re-run safely on a database that already has part of it.

CREATE TABLE IF NOT EXISTS "variant_quarantines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "variant_id" UUID NOT NULL,
  "quarantine_qty" INTEGER NOT NULL,
  "quarantined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "quarantined_by" UUID NOT NULL,
  "quarantine_note" VARCHAR(500),
  "created_at" TIMESTAMPTZ(6) DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) DEFAULT now(),

  CONSTRAINT "variant_quarantines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "variant_quarantines_quarantine_qty_check" CHECK ("quarantine_qty" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_variant_quarantine_tenant_variant"
  ON "variant_quarantines" ("business_id", "variant_id");
CREATE INDEX IF NOT EXISTS "idx_variant_quarantines_business"
  ON "variant_quarantines" ("business_id");

ALTER TABLE "variant_quarantines" DROP CONSTRAINT IF EXISTS "variant_quarantines_business_id_fkey";
ALTER TABLE "variant_quarantines"
  ADD CONSTRAINT "variant_quarantines_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "variant_quarantines" DROP CONSTRAINT IF EXISTS "variant_quarantines_variant_id_fkey";
ALTER TABLE "variant_quarantines"
  ADD CONSTRAINT "variant_quarantines_variant_id_fkey"
  FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "variant_quarantines" DROP CONSTRAINT IF EXISTS "variant_quarantines_quarantined_by_fkey";
ALTER TABLE "variant_quarantines"
  ADD CONSTRAINT "variant_quarantines_quarantined_by_fkey"
  FOREIGN KEY ("quarantined_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- One open (PENDING) scrap order per variant, for the orders that have no lot item.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_scrap_orders_one_pending_per_variant"
  ON "scrap_orders" ("variant_id")
  WHERE "status" = 'PENDING' AND "lot_item_id" IS NULL;
