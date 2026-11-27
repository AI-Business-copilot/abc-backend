-- F08: tax and disposal dossier fields on scrap_orders.
-- Thông tư 78/2014 (as amended by Thông tư 96/2015) requires the disposal dossier to state the
-- cause of the loss, the amount recovered from an insurer or a third party, how and where the
-- goods were destroyed, and who witnessed the destruction. All columns are nullable so the
-- existing rows and the current workflow keep working.
-- Idempotent where practical so it can be re-run safely on a database that already has part of it.

ALTER TABLE "scrap_orders"
  ADD COLUMN IF NOT EXISTS "cause_code" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "compensated_amount" DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "disposal_date" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "disposal_method" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "disposal_location" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "witness_names" VARCHAR(500);

-- The dossier may name the disposal method only from the list the tax dossier accepts.
ALTER TABLE "scrap_orders" DROP CONSTRAINT IF EXISTS "scrap_orders_cause_code_check";
ALTER TABLE "scrap_orders"
  ADD CONSTRAINT "scrap_orders_cause_code_check"
  CHECK ("cause_code" IS NULL OR "cause_code" IN ('EXPIRED', 'DAMAGED_TRANSIT', 'QUALITY_FAIL', 'OLD_STOCK'));

ALTER TABLE "scrap_orders" DROP CONSTRAINT IF EXISTS "scrap_orders_disposal_method_check";
ALTER TABLE "scrap_orders"
  ADD CONSTRAINT "scrap_orders_disposal_method_check"
  CHECK ("disposal_method" IS NULL OR "disposal_method" IN ('INCINERATION', 'BURIAL', 'CHEMICAL', 'CONTRACTOR'));

-- A contractor needs an address: without it the disposal cannot be traced.
ALTER TABLE "scrap_orders" DROP CONSTRAINT IF EXISTS "scrap_orders_disposal_location_check";
ALTER TABLE "scrap_orders"
  ADD CONSTRAINT "scrap_orders_disposal_location_check"
  CHECK ("disposal_method" IS DISTINCT FROM 'CONTRACTOR' OR NULLIF(TRIM("disposal_location"), '') IS NOT NULL);

-- The council needs at least two witnesses.
ALTER TABLE "scrap_orders" DROP CONSTRAINT IF EXISTS "scrap_orders_witness_names_check";
ALTER TABLE "scrap_orders"
  ADD CONSTRAINT "scrap_orders_witness_names_check"
  CHECK ("witness_names" IS NULL OR ARRAY_LENGTH(STRING_TO_ARRAY("witness_names", ','), 1) >= 2);

-- The recovered amount cannot be negative and cannot exceed the loss it comes from.
ALTER TABLE "scrap_orders" DROP CONSTRAINT IF EXISTS "scrap_orders_compensated_amount_check";
ALTER TABLE "scrap_orders"
  ADD CONSTRAINT "scrap_orders_compensated_amount_check"
  CHECK ("compensated_amount" IS NULL OR "compensated_amount" >= 0);

-- F08: what a stored file is. The dossier may hold an insurance claim or a liability notice
-- next to the evidence photos.
ALTER TABLE "scrap_order_images"
  ADD COLUMN IF NOT EXISTS "document_type" VARCHAR(50);

ALTER TABLE "scrap_order_images" DROP CONSTRAINT IF EXISTS "scrap_order_images_document_type_check";
ALTER TABLE "scrap_order_images"
  ADD CONSTRAINT "scrap_order_images_document_type_check"
  CHECK ("document_type" IS NULL OR "document_type" IN ('PHOTO', 'INSURANCE_CLAIM', 'LIABILITY_NOTICE'));

-- F08: the physical disposal is recorded in the ledger once it is confirmed. The quantity was
-- already written off by the SCRAP_DISPOSAL row, so this row changes no stock.
DO $$ BEGIN
  ALTER TYPE "stock_transaction_type" ADD VALUE IF NOT EXISTS 'SCRAP_PHYSICALLY_DISPOSED';
EXCEPTION WHEN others THEN NULL;
END $$;
