BEGIN;

ALTER TABLE "ai_insights" DROP CONSTRAINT "ai_insights_type_check";
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_type_check"
  CHECK ("type" IN ('LOW_STOCK', 'SLOW_MOVING', 'DECLINING_SALES', 'OVERSTOCK', 'EXPIRATION_RISK', 'STOCKOUT_RISK'));

-- Latest demand forecast per product; history of accuracy is kept separately.
CREATE TABLE "ai_forecasts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "variant_id" UUID NOT NULL,
  "run_id" UUID,
  "as_of" DATE NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "model" VARCHAR(20),
  "confidence" VARCHAR(10),
  "daily_rate" DECIMAL(12,4) NOT NULL DEFAULT 0,
  "result" JSONB NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_forecasts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_forecasts_status_check" CHECK ("status" IN ('OK', 'INSUFFICIENT_DATA')),
  CONSTRAINT "ai_forecasts_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ai_forecasts_variant_fkey"
    FOREIGN KEY ("business_id", "variant_id")
    REFERENCES "product_variants"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "uq_ai_forecasts_variant" ON "ai_forecasts"("business_id", "variant_id");

-- One live purchase suggestion per product; the owner accepts it into a draft PO or dismisses it.
CREATE TABLE "ai_replenishment_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "variant_id" UUID NOT NULL,
  "run_id" UUID,
  "supplier_id" UUID,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "urgency" VARCHAR(10) NOT NULL,
  "confidence" VARCHAR(10),
  "suggested_qty" INTEGER NOT NULL,
  "unit_cost" DECIMAL(12,2) NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "order_by_date" DATE,
  "stockout_date" DATE,
  "details" JSONB NOT NULL,
  "snooze_until" DATE,
  "po_id" UUID,
  "handled_by" UUID,
  "handled_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_replenishment_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_replenishment_items_status_check"
    CHECK ("status" IN ('PENDING', 'ORDERED', 'DISMISSED', 'RESOLVED')),
  CONSTRAINT "ai_replenishment_items_urgency_check" CHECK ("urgency" IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  CONSTRAINT "ai_replenishment_items_qty_check" CHECK ("suggested_qty" > 0),
  CONSTRAINT "ai_replenishment_items_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ai_replenishment_items_variant_fkey"
    FOREIGN KEY ("business_id", "variant_id")
    REFERENCES "product_variants"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "ai_replenishment_items_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "ai_replenishment_items_po_id_fkey"
    FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "uq_ai_replenishment_variant" ON "ai_replenishment_items"("business_id", "variant_id");
CREATE INDEX "idx_ai_replenishment_status" ON "ai_replenishment_items"("business_id", "status", "urgency");

ALTER TABLE "ai_forecasts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_replenishment_items" ENABLE ROW LEVEL SECURITY;

COMMIT;
