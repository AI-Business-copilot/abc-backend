CREATE TABLE "notification_reads" (
  "business_id" UUID NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "notification_id" VARCHAR(200) NOT NULL,
  "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("business_id", "user_id", "notification_id")
);

-- Receipts are accessed through the authenticated API only.
ALTER TABLE "notification_reads" ENABLE ROW LEVEL SECURITY;
