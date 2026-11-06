-- Owner-assigned audit items: creator tracking and lot number / new lot data

ALTER TABLE "stock_audits"
ADD COLUMN "created_by" UUID;

ALTER TABLE "stock_audit_items"
ADD COLUMN "created_by" UUID,
ADD COLUMN "lot_number" VARCHAR(100),
ADD COLUMN "new_lot_expiration_date" DATE,
ADD COLUMN "new_lot_manufacturing_date" DATE;

ALTER TABLE "stock_audits"
ADD CONSTRAINT "fk_stock_audits_created_by_user_id"
  FOREIGN KEY ("created_by")
  REFERENCES "users"("id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;

ALTER TABLE "stock_audit_items"
ADD CONSTRAINT "fk_stock_audit_items_created_by_user_id"
  FOREIGN KEY ("created_by")
  REFERENCES "users"("id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;

-- Backfill lot_number for existing items that already point at a lot
UPDATE "stock_audit_items" sai
SET "lot_number" = pl."lot_number"
FROM "product_lots" pl
WHERE sai."lot_id" = pl."id"
  AND sai."lot_number" IS NULL;
