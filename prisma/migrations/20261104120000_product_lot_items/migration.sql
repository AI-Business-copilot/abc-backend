-- A lot number is now a batch header that can cover several variants.
-- Each variant inside the batch gets its own product_lot_items row, which owns the
-- manufacturing/expiry dates, the calculated status and the quarantine state.
--
-- Every table that pointed at product_lots now points at product_lot_items instead.
--
-- Idempotent on purpose: it also succeeds when product_lots was dropped by hand first.
-- Rows that referenced a lot are removed rather than migrated, because one old lot row
-- cannot be split into per-variant items without guessing the dates. Rows that never
-- carried a lot (plain variant-level balances, orders without lot tracking) are kept.

-- 1. Drop the rows that referenced a lot. Order matters: customer returns reference order items.
DELETE FROM "customer_return_items"
 WHERE "lot_id" IS NOT NULL
    OR "order_item_id" IN (SELECT "id" FROM "order_items" WHERE "lot_id" IS NOT NULL);

DELETE FROM "order_items" WHERE "lot_id" IS NOT NULL;
DELETE FROM "scrap_orders" WHERE "lot_id" IS NOT NULL;
DELETE FROM "stock_audit_items" WHERE "lot_id" IS NOT NULL OR "lot_number" IS NOT NULL;
DELETE FROM "inventory_ledger" WHERE "lot_id" IS NOT NULL;
DELETE FROM "inventory_balances" WHERE "lot_id" IS NOT NULL;
DELETE FROM "opening_stock_items" WHERE "lot_id" IS NOT NULL;
DELETE FROM "purchase_receipt_items" WHERE "lot_id" IS NOT NULL;
DELETE FROM "vendor_return_items" WHERE "lot_id" IS NOT NULL;

-- 2. Drop the indexes that mention the columns about to disappear.
DROP INDEX IF EXISTS "uq_inventory_balance_no_lot";
DROP INDEX IF EXISTS "uq_inventory_balance_with_lot";
DROP INDEX IF EXISTS "uq_scrap_orders_one_pending_per_lot";

-- 3. Drop the old lot tables. CASCADE removes the foreign keys the nine tables hold on product_lots.
DROP TABLE IF EXISTS "product_lot_items" CASCADE;
DROP TABLE IF EXISTS "product_lots" CASCADE;

-- 4. Replace lot_id with lot_item_id on the dependent tables.
ALTER TABLE "inventory_balances" DROP CONSTRAINT IF EXISTS "inventory_balances_lot_id_fkey";
ALTER TABLE "inventory_balances" DROP COLUMN IF EXISTS "lot_id";
ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "lot_item_id" UUID;

ALTER TABLE "inventory_ledger" DROP CONSTRAINT IF EXISTS "inventory_ledger_lot_id_fkey";
ALTER TABLE "inventory_ledger" DROP COLUMN IF EXISTS "lot_id";
ALTER TABLE "inventory_ledger" ADD COLUMN IF NOT EXISTS "lot_item_id" UUID;

ALTER TABLE "opening_stock_items" DROP CONSTRAINT IF EXISTS "opening_stock_items_lot_id_fkey";
ALTER TABLE "opening_stock_items" DROP COLUMN IF EXISTS "lot_id";
ALTER TABLE "opening_stock_items" ADD COLUMN IF NOT EXISTS "lot_item_id" UUID;

ALTER TABLE "purchase_receipt_items" DROP CONSTRAINT IF EXISTS "purchase_receipt_items_lot_id_fkey";
ALTER TABLE "purchase_receipt_items" DROP COLUMN IF EXISTS "lot_id";
ALTER TABLE "purchase_receipt_items" ADD COLUMN IF NOT EXISTS "lot_item_id" UUID;

ALTER TABLE "vendor_return_items" DROP CONSTRAINT IF EXISTS "vendor_return_items_lot_id_fkey";
ALTER TABLE "vendor_return_items" DROP COLUMN IF EXISTS "lot_id";
ALTER TABLE "vendor_return_items" ADD COLUMN IF NOT EXISTS "lot_item_id" UUID;

ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_lot_id_fkey";
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "lot_id";
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "lot_item_id" UUID;

ALTER TABLE "customer_return_items" DROP CONSTRAINT IF EXISTS "customer_return_items_lot_id_fkey";
ALTER TABLE "customer_return_items" DROP COLUMN IF EXISTS "lot_id";
ALTER TABLE "customer_return_items" ADD COLUMN IF NOT EXISTS "lot_item_id" UUID;

ALTER TABLE "stock_audit_items" DROP CONSTRAINT IF EXISTS "stock_audit_items_lot_id_fkey";
ALTER TABLE "stock_audit_items" DROP COLUMN IF EXISTS "lot_id";
ALTER TABLE "stock_audit_items" ADD COLUMN IF NOT EXISTS "lot_item_id" UUID;

ALTER TABLE "scrap_orders" DROP CONSTRAINT IF EXISTS "scrap_orders_lot_id_fkey";
ALTER TABLE "scrap_orders" DROP COLUMN IF EXISTS "lot_id";
ALTER TABLE "scrap_orders" ADD COLUMN IF NOT EXISTS "lot_item_id" UUID;

-- 5. Recreate product_lots as the batch header.
CREATE TABLE "product_lots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "lot_number" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_lots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_lot_tenant_number" ON "product_lots"("business_id", "lot_number");

ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 6. Create product_lot_items, one row per variant in the batch.
CREATE TABLE "product_lot_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "manufacturing_date" DATE,
    "expiration_date" DATE NOT NULL,
    "alert_days_before" INTEGER DEFAULT 30,
    "status" VARCHAR(30) NOT NULL DEFAULT 'HEALTHY',
    "is_locked_for_audit" BOOLEAN NOT NULL DEFAULT false,
    "quarantine_qty" INTEGER,
    "quarantined_at" TIMESTAMPTZ(6),
    "quarantined_by" UUID,
    "quarantine_note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_lot_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_lot_items_quarantine_qty_check" CHECK ("quarantine_qty" IS NULL OR "quarantine_qty" > 0),
    CONSTRAINT "product_lot_items_status_check" CHECK ("status" IN ('HEALTHY', 'WARNING', 'UNUSABLE', 'QUARANTINED', 'SCRAPPED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_product_lot_item" ON "product_lot_items"("business_id", "lot_id", "variant_id");
CREATE INDEX IF NOT EXISTS "idx_product_lot_items_business_status" ON "product_lot_items"("business_id", "status");
CREATE INDEX IF NOT EXISTS "idx_product_lot_items_expiration_date" ON "product_lot_items"("business_id", "expiration_date");

ALTER TABLE "product_lot_items" ADD CONSTRAINT "product_lot_items_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "product_lot_items" ADD CONSTRAINT "product_lot_items_lot_id_fkey"
  FOREIGN KEY ("lot_id") REFERENCES "product_lots"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "product_lot_items" ADD CONSTRAINT "product_lot_items_variant_id_fkey"
  FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "product_lot_items" ADD CONSTRAINT "product_lot_items_quarantined_by_fkey"
  FOREIGN KEY ("quarantined_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 7. Point the dependent tables at the new rows.
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_lot_item_id_fkey"
  FOREIGN KEY ("lot_item_id") REFERENCES "product_lot_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_lot_item_id_fkey"
  FOREIGN KEY ("lot_item_id") REFERENCES "product_lot_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "opening_stock_items" ADD CONSTRAINT "opening_stock_items_lot_item_id_fkey"
  FOREIGN KEY ("lot_item_id") REFERENCES "product_lot_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_lot_item_id_fkey"
  FOREIGN KEY ("lot_item_id") REFERENCES "product_lot_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "vendor_return_items" ADD CONSTRAINT "vendor_return_items_lot_item_id_fkey"
  FOREIGN KEY ("lot_item_id") REFERENCES "product_lot_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_lot_item_id_fkey"
  FOREIGN KEY ("lot_item_id") REFERENCES "product_lot_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "customer_return_items" ADD CONSTRAINT "customer_return_items_lot_item_id_fkey"
  FOREIGN KEY ("lot_item_id") REFERENCES "product_lot_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "stock_audit_items" ADD CONSTRAINT "stock_audit_items_lot_item_id_fkey"
  FOREIGN KEY ("lot_item_id") REFERENCES "product_lot_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "scrap_orders" ADD CONSTRAINT "scrap_orders_lot_item_id_fkey"
  FOREIGN KEY ("lot_item_id") REFERENCES "product_lot_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 8. Recreate the partial unique indexes, now keyed on the lot item.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inventory_balance_no_lot"
  ON "inventory_balances"("business_id", "variant_id") WHERE ("lot_item_id" IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inventory_balance_with_lot"
  ON "inventory_balances"("business_id", "variant_id", "lot_item_id") WHERE ("lot_item_id" IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_scrap_orders_one_pending_per_lot"
  ON "scrap_orders"("lot_item_id") WHERE ("status" = 'PENDING' AND "lot_item_id" IS NOT NULL);
