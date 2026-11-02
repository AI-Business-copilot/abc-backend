-- Align product_lots.status with the values the backend writes.
-- Some databases still carry the earlier constraint (ACTIVE, QUARANTINED, SCRAPPED), which rejects
-- the calculated statuses HEALTHY / WARNING / UNUSABLE (error 23514). This migration is idempotent.

-- The old constraint must go first, otherwise it blocks the UPDATE below.
ALTER TABLE "product_lots" DROP CONSTRAINT IF EXISTS "product_lots_status_check";

-- Convert legacy ACTIVE lots to the status calculated from the expiration date.
-- Same thresholds as LotStatusService.calculateStatus: > 60 days HEALTHY, 8-60 WARNING, otherwise UNUSABLE.
UPDATE "product_lots"
SET "status" = CASE
  WHEN ("expiration_date" - CURRENT_DATE) > 60 THEN 'HEALTHY'
  WHEN ("expiration_date" - CURRENT_DATE) >= 8 THEN 'WARNING'
  ELSE 'UNUSABLE'
END
WHERE "status" = 'ACTIVE';

ALTER TABLE "product_lots"
ADD CONSTRAINT "product_lots_status_check"
  CHECK ("status" IN ('HEALTHY', 'WARNING', 'UNUSABLE', 'QUARANTINED', 'SCRAPPED'));

ALTER TABLE "product_lots" ALTER COLUMN "status" SET DEFAULT 'HEALTHY';
