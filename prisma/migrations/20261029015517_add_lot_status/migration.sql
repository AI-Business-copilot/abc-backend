-- Add status column to product_lots
ALTER TABLE "product_lots" ADD COLUMN "status" VARCHAR(30) NOT NULL DEFAULT 'ACTIVE';

-- Add constraint for valid status values
ALTER TABLE "product_lots" ADD CONSTRAINT "product_lots_status_check" 
  CHECK ("status" IN ('ACTIVE', 'QUARANTINED', 'SCRAPPED'));

-- Create index for efficient filtering
CREATE INDEX "idx_product_lots_business_status" ON "product_lots"("business_id", "status");
