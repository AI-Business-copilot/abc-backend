BEGIN;

CREATE UNIQUE INDEX "uq_category_tenant_id" ON "categories"("business_id", "id");
CREATE UNIQUE INDEX "uq_template_tenant_id" ON "product_templates"("business_id", "id");
CREATE UNIQUE INDEX "uq_order_tenant_id" ON "orders"("business_id", "id");

CREATE TABLE "promotions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "name" VARCHAR(150) NOT NULL,
  "description" TEXT,
  "discount_type" VARCHAR(20) NOT NULL,
  "discount_value" DECIMAL(12,2) NOT NULL,
  "scope" VARCHAR(20) NOT NULL,
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "ends_at" TIMESTAMPTZ(6) NOT NULL,
  "min_order_amount" DECIMAL(12,2),
  "usage_limit" INTEGER,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "promotions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promotions_discount_type_check" CHECK ("discount_type" IN ('PERCENTAGE', 'FIXED_AMOUNT')),
  CONSTRAINT "promotions_discount_value_check" CHECK (
    "discount_value" > 0 AND
    ("discount_type" <> 'PERCENTAGE' OR "discount_value" <= 100)
  ),
  CONSTRAINT "promotions_scope_check" CHECK ("scope" IN ('STORE', 'CATEGORY', 'PRODUCT')),
  CONSTRAINT "promotions_dates_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "promotions_min_order_check" CHECK ("min_order_amount" IS NULL OR "min_order_amount" >= 0),
  CONSTRAINT "promotions_usage_limit_check" CHECK ("usage_limit" IS NULL OR "usage_limit" > 0),
  CONSTRAINT "promotions_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED')),
  CONSTRAINT "promotions_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "promotions_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "uq_promotions_business_id" ON "promotions"("business_id", "id");
CREATE INDEX "idx_promotions_business_status_dates"
  ON "promotions"("business_id", "status", "starts_at", "ends_at");

CREATE TABLE "promotion_targets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "promotion_id" UUID NOT NULL,
  "target_type" VARCHAR(20) NOT NULL,
  "category_id" UUID,
  "product_template_id" UUID,

  CONSTRAINT "promotion_targets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promotion_targets_type_target_check" CHECK (
    ("target_type" = 'CATEGORY' AND "category_id" IS NOT NULL AND "product_template_id" IS NULL) OR
    ("target_type" = 'PRODUCT' AND "product_template_id" IS NOT NULL AND "category_id" IS NULL)
  ),
  CONSTRAINT "promotion_targets_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "promotion_targets_business_id_promotion_id_fkey"
    FOREIGN KEY ("business_id", "promotion_id") REFERENCES "promotions"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "promotion_targets_business_id_category_id_fkey"
    FOREIGN KEY ("business_id", "category_id") REFERENCES "categories"("business_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "promotion_targets_business_id_product_template_id_fkey"
    FOREIGN KEY ("business_id", "product_template_id") REFERENCES "product_templates"("business_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "uq_promotion_targets_category"
  ON "promotion_targets"("promotion_id", "category_id") WHERE "category_id" IS NOT NULL;
CREATE UNIQUE INDEX "uq_promotion_targets_product"
  ON "promotion_targets"("promotion_id", "product_template_id") WHERE "product_template_id" IS NOT NULL;
CREATE INDEX "idx_promotion_targets_business_promotion"
  ON "promotion_targets"("business_id", "promotion_id");

ALTER TABLE "orders"
  ADD COLUMN "promotion_id" UUID,
  ADD COLUMN "promotion_snapshot" JSONB,
  ADD CONSTRAINT "orders_business_id_promotion_id_fkey"
    FOREIGN KEY ("business_id", "promotion_id") REFERENCES "promotions"("business_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "customer_return_items"
  ADD COLUMN "refund_amount" DECIMAL(12,2);
UPDATE "customer_return_items"
   SET "refund_amount" = "return_qty" * "refund_unit_price";
ALTER TABLE "customer_return_items"
  ALTER COLUMN "refund_amount" SET NOT NULL,
  ADD CONSTRAINT "customer_return_items_refund_amount_check" CHECK ("refund_amount" >= 0);

CREATE TABLE "promotion_redemptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "promotion_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "discount_amount" DECIMAL(12,2) NOT NULL,
  "redeemed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "promotion_redemptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promotion_redemptions_discount_amount_check" CHECK ("discount_amount" > 0),
  CONSTRAINT "promotion_redemptions_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "promotion_redemptions_business_id_promotion_id_fkey"
    FOREIGN KEY ("business_id", "promotion_id") REFERENCES "promotions"("business_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "promotion_redemptions_business_id_order_id_fkey"
    FOREIGN KEY ("business_id", "order_id") REFERENCES "orders"("business_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "uq_promotion_redemptions_order" ON "promotion_redemptions"("order_id");
CREATE UNIQUE INDEX "uq_promotion_redemptions_promotion_order"
  ON "promotion_redemptions"("promotion_id", "order_id");
CREATE UNIQUE INDEX "uq_promotion_redemptions_business_order"
  ON "promotion_redemptions"("business_id", "order_id");
CREATE INDEX "idx_promotion_redemptions_business_date"
  ON "promotion_redemptions"("business_id", "promotion_id", "redeemed_at");

INSERT INTO "permissions" ("code", "scope", "description")
VALUES ('promotions.manage', 'BUSINESS', 'Create, update, and pause store promotions.')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" = 'promotions.manage'
WHERE r."scope" = 'BUSINESS' AND r."code" = 'OWNER'
ON CONFLICT DO NOTHING;

ALTER TABLE "promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion_targets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion_redemptions" ENABLE ROW LEVEL SECURITY;

COMMIT;
