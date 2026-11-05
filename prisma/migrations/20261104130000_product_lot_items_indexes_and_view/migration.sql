-- Two lookups added by the lot split had no index:
--   * the audit lot picker and GET /inventory/lots?variantId= filter by business + variant
--   * a batch detail lists the items of one batch
CREATE INDEX IF NOT EXISTS "idx_product_lot_items_business_variant"
  ON "product_lot_items" ("business_id", "variant_id");

CREATE INDEX IF NOT EXISTS "idx_product_lot_items_lot"
  ON "product_lot_items" ("lot_id");

-- v_product_lots was dropped together with the old product_lots table, but the Prisma view model
-- still maps to it. Rebuild it over the batch header + item join: the row id is the lot item, the
-- batch number comes from the header, and the expiry maths keeps the legacy definition.
CREATE OR REPLACE VIEW "v_product_lots" AS
SELECT
    i."id",
    i."business_id",
    i."lot_id",
    i."variant_id",
    l."lot_number",
    i."manufacturing_date",
    i."expiration_date",
    i."alert_days_before",
    i."created_at",
    (i."expiration_date" <= CURRENT_DATE) AS "is_expired",
    ((i."expiration_date" - CURRENT_DATE) <= i."alert_days_before"
      AND i."expiration_date" > CURRENT_DATE) AS "is_near_expiry",
    (i."expiration_date" - CURRENT_DATE) AS "days_remaining"
FROM "product_lot_items" i
JOIN "product_lots" l ON l."id" = i."lot_id";
