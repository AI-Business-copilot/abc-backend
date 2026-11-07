BEGIN;

CREATE INDEX "idx_orders_business_status_created"
  ON "orders"("business_id", "status", "created_at");
CREATE INDEX "idx_returns_business_status_created"
  ON "customer_returns"("business_id", "status", "created_at");

CREATE TABLE "online_report_import_batches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "imported_by" UUID NOT NULL,
  "platform" VARCHAR(20) NOT NULL,
  "file_hash" CHAR(64) NOT NULL,
  "report_from" DATE,
  "report_to" DATE,
  "source_row_count" INTEGER NOT NULL,
  "imported_row_count" INTEGER NOT NULL,
  "summary" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "online_report_import_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "online_report_import_batches_platform_check" CHECK ("platform" = 'SHOPEE'),
  CONSTRAINT "online_report_import_batches_counts_check" CHECK ("source_row_count" >= 0 AND "imported_row_count" >= 0),
  CONSTRAINT "online_report_import_batches_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "online_report_import_batches_imported_by_fkey"
    FOREIGN KEY ("imported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "uq_online_report_batches_business_id" ON "online_report_import_batches"("business_id", "id");
CREATE UNIQUE INDEX "uq_online_report_batches_file"
  ON "online_report_import_batches"("business_id", "platform", "file_hash");
CREATE INDEX "idx_online_report_batches_business_created"
  ON "online_report_import_batches"("business_id", "created_at" DESC);

CREATE TABLE "online_report_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "batch_id" UUID NOT NULL,
  "platform" VARCHAR(20) NOT NULL,
  "record_type" VARCHAR(32) NOT NULL,
  "source_key" CHAR(64) NOT NULL,
  "source_sheet" VARCHAR(80) NOT NULL,
  "source_row" INTEGER NOT NULL,
  "external_order_id" VARCHAR(100),
  "external_product_id" VARCHAR(100),
  "product_name" TEXT,
  "transaction_date" DATE,
  "settlement_date" DATE,
  "financial_data" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "online_report_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "online_report_records_platform_check" CHECK ("platform" = 'SHOPEE'),
  CONSTRAINT "online_report_records_type_check"
    CHECK ("record_type" IN ('ORDER', 'SKU', 'ADJUSTMENT', 'SERVICE_FEE', 'SHIPPING_DISCREPANCY')),
  CONSTRAINT "online_report_records_source_row_check" CHECK ("source_row" > 0),
  CONSTRAINT "online_report_records_batch_fkey"
    FOREIGN KEY ("business_id", "batch_id")
    REFERENCES "online_report_import_batches"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "uq_online_report_records_source"
  ON "online_report_records"("business_id", "platform", "source_key");
CREATE INDEX "idx_online_report_records_business_date"
  ON "online_report_records"("business_id", "platform", "transaction_date");
CREATE INDEX "idx_online_report_records_batch"
  ON "online_report_records"("business_id", "batch_id");

CREATE TABLE "channel_daily_product_metrics" (
  "business_id" UUID NOT NULL,
  "variant_id" UUID NOT NULL,
  "channel" VARCHAR(20) NOT NULL DEFAULT 'POS',
  "metric_date" DATE NOT NULL,
  "units_sold" INTEGER NOT NULL DEFAULT 0,
  "units_returned" INTEGER NOT NULL DEFAULT 0,
  "order_count" INTEGER NOT NULL DEFAULT 0,
  "gross_sales" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discount_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "refund_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "returned_cogs" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "net_revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "net_cogs" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "channel_daily_product_metrics_pkey"
    PRIMARY KEY ("business_id", "channel", "variant_id", "metric_date"),
  CONSTRAINT "channel_daily_product_metrics_channel_check" CHECK ("channel" IN ('POS')),
  CONSTRAINT "channel_daily_product_metrics_nonnegative_check"
    CHECK ("units_sold" >= 0 AND "units_returned" >= 0 AND "order_count" >= 0),
  CONSTRAINT "channel_daily_product_metrics_business_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "channel_daily_product_metrics_variant_fkey"
    FOREIGN KEY ("business_id", "variant_id")
    REFERENCES "product_variants"("business_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "idx_channel_daily_metrics_business_date"
  ON "channel_daily_product_metrics"("business_id", "channel", "metric_date");

ALTER TABLE "online_report_import_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "online_report_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_daily_product_metrics" ENABLE ROW LEVEL SECURITY;

INSERT INTO "permissions" ("code", "scope", "description")
VALUES ('business_data.manage', 'BUSINESS', 'Import channel reports and rebuild business data aggregates.')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" = 'business_data.manage'
WHERE r."scope" = 'BUSINESS' AND r."code" = 'OWNER'
ON CONFLICT DO NOTHING;

COMMIT;
