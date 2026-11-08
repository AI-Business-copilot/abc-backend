-- Backfill missing lot_item_id on legacy rows from product_lot_items
UPDATE "inventory_balances" ib
SET "lot_item_id" = pli."id"
FROM "product_lot_items" pli
WHERE ib."lot_item_id" IS NULL
  AND ib."lot_id" = pli."lot_id"
  AND ib."variant_id" = pli."variant_id";

UPDATE "inventory_ledger" il
SET "lot_item_id" = pli."id"
FROM "product_lot_items" pli
WHERE il."lot_item_id" IS NULL
  AND il."lot_id" = pli."lot_id"
  AND il."variant_id" = pli."variant_id";

UPDATE "opening_stock_items" osi
SET "lot_item_id" = pli."id"
FROM "product_lot_items" pli
WHERE osi."lot_item_id" IS NULL
  AND osi."lot_id" = pli."lot_id"
  AND osi."variant_id" = pli."variant_id";

-- Drop legacy partial unique indexes that referenced old lot_id column
DROP INDEX IF EXISTS "uq_inventory_balance_no_lot";
DROP INDEX IF EXISTS "uq_inventory_balance_with_lot";

-- Recreate partial unique indexes using lot_item_id matching schema.prisma
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inventory_balance_no_lot"
  ON "inventory_balances"("business_id", "variant_id")
  WHERE ("lot_item_id" IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_inventory_balance_with_lot"
  ON "inventory_balances"("business_id", "variant_id", "lot_item_id")
  WHERE ("lot_item_id" IS NOT NULL);
