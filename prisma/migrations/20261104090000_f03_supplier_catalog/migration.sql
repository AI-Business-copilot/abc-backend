-- F03 core only. Do not apply over an existing supplier_products table without
-- comparing its structure and migration history first.
BEGIN;

ALTER TABLE "suppliers"
  ADD COLUMN "supplier_code" VARCHAR(50),
  ADD COLUMN "email" VARCHAR(255),
  ADD COLUMN "address" TEXT,
  ADD COLUMN "tax_code" VARCHAR(30),
  ADD COLUMN "note" TEXT,
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "uq_supplier_tenant_id" ON "suppliers"("business_id", "id");
CREATE UNIQUE INDEX "uq_supplier_tenant_code" ON "suppliers"("business_id", "supplier_code");
CREATE UNIQUE INDEX "uq_variant_tenant_id" ON "product_variants"("business_id", "id");

CREATE TABLE "supplier_products" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "variant_id" UUID NOT NULL,
  "supplier_sku" VARCHAR(100),
  "supplier_product_name" VARCHAR(255),
  "supply_price" DECIMAL(12,2) NOT NULL,
  "min_order_qty" INTEGER NOT NULL DEFAULT 1,
  "order_multiple" INTEGER NOT NULL DEFAULT 1,
  "lead_time_days" INTEGER,
  "is_preferred" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "price_updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_products_supply_price_check" CHECK ("supply_price" >= 0),
  CONSTRAINT "supplier_products_min_order_qty_check" CHECK ("min_order_qty" > 0),
  CONSTRAINT "supplier_products_order_multiple_check" CHECK ("order_multiple" > 0),
  CONSTRAINT "supplier_products_lead_time_days_check" CHECK ("lead_time_days" IS NULL OR "lead_time_days" >= 0),
  CONSTRAINT "supplier_products_preferred_active_check" CHECK (NOT "is_preferred" OR "is_active"),
  CONSTRAINT "supplier_products_business_id_fkey" FOREIGN KEY ("business_id")
    REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "supplier_products_business_id_supplier_id_fkey" FOREIGN KEY ("business_id", "supplier_id")
    REFERENCES "suppliers"("business_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "supplier_products_business_id_variant_id_fkey" FOREIGN KEY ("business_id", "variant_id")
    REFERENCES "product_variants"("business_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "uq_supplier_product_tenant_supplier_variant"
  ON "supplier_products"("business_id", "supplier_id", "variant_id");
CREATE UNIQUE INDEX "uq_supplier_product_preferred"
  ON "supplier_products"("business_id", "variant_id") WHERE (is_preferred = true AND is_active = true);
CREATE INDEX "idx_supplier_products_supplier_active"
  ON "supplier_products"("business_id", "supplier_id", "is_active");
CREATE INDEX "idx_supplier_products_variant_active"
  ON "supplier_products"("business_id", "variant_id", "is_active");

-- Access goes through the backend, as for the existing business tables.
-- No direct anon/authenticated Data API access is granted here.
ALTER TABLE "supplier_products" ENABLE ROW LEVEL SECURITY;

COMMIT;
