-- Add status column to product_lots
ALTER TABLE "product_lots" ADD COLUMN "status" VARCHAR(30) NOT NULL DEFAULT 'HEALTHY';

-- Add constraint for valid status values (includes calculated + db statuses)
-- Calculated: HEALTHY (>60 days), WARNING (8-60 days), UNUSABLE (≤7 days)
-- Explicit: QUARANTINED, SCRAPPED
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_status_check" 
  CHECK ("status" IN ('HEALTHY', 'WARNING', 'UNUSABLE', 'QUARANTINED', 'SCRAPPED'));

-- Create index for efficient filtering and expiry date queries
CREATE INDEX "idx_product_lots_business_status" ON "product_lots"("business_id", "status");
CREATE INDEX "idx_product_lots_expiration_date" ON "product_lots"("business_id", "expiration_date");
