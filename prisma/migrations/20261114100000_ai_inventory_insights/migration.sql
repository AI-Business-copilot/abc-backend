BEGIN;

-- The legacy table is no longer written; POS metrics live in channel_daily_product_metrics.
DROP TABLE IF EXISTS "daily_product_metrics";

CREATE TABLE "ai_insight_settings" (
  "business_id" UUID NOT NULL,
  "settings" JSONB NOT NULL,
  "updated_by" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_insight_settings_pkey" PRIMARY KEY ("business_id"),
  CONSTRAINT "ai_insight_settings_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE TABLE "ai_insight_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "trigger_type" VARCHAR(20) NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "data_as_of" DATE NOT NULL,
  "triggered_by" UUID,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(6),
  "summary" JSONB,
  "warnings" JSONB,
  "error" TEXT,
  CONSTRAINT "ai_insight_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_insight_runs_trigger_check" CHECK ("trigger_type" IN ('MANUAL', 'SCHEDULED')),
  CONSTRAINT "ai_insight_runs_status_check" CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  CONSTRAINT "ai_insight_runs_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "idx_ai_insight_runs_business_started"
  ON "ai_insight_runs"("business_id", "started_at" DESC);

CREATE TABLE "ai_insights" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "type" VARCHAR(30) NOT NULL,
  "fingerprint" VARCHAR(160) NOT NULL,
  "variant_id" UUID NOT NULL,
  "lot_item_id" UUID,
  "severity" VARCHAR(10) NOT NULL,
  "reason_code" VARCHAR(60) NOT NULL,
  "suggested_action" VARCHAR(40) NOT NULL,
  "metrics" JSONB NOT NULL,
  "value_at_risk" DECIMAL(14,2),
  "priority_score" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  "snooze_until" DATE,
  "handled_by" UUID,
  "handled_at" TIMESTAMPTZ(6),
  "first_detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "ai_insights_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_insights_type_check"
    CHECK ("type" IN ('LOW_STOCK', 'SLOW_MOVING', 'DECLINING_SALES', 'OVERSTOCK', 'EXPIRATION_RISK')),
  CONSTRAINT "ai_insights_severity_check" CHECK ("severity" IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  CONSTRAINT "ai_insights_status_check" CHECK ("status" IN ('OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'RESOLVED')),
  CONSTRAINT "ai_insights_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ai_insights_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "ai_insight_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "ai_insights_variant_fkey"
    FOREIGN KEY ("business_id", "variant_id")
    REFERENCES "product_variants"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "ai_insights_lot_item_id_fkey"
    FOREIGN KEY ("lot_item_id") REFERENCES "product_lot_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "uq_ai_insights_fingerprint" ON "ai_insights"("business_id", "fingerprint");
CREATE INDEX "idx_ai_insights_business_status" ON "ai_insights"("business_id", "status", "severity");
CREATE INDEX "idx_ai_insights_business_type" ON "ai_insights"("business_id", "type", "status");

ALTER TABLE "ai_insight_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_insight_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_insights" ENABLE ROW LEVEL SECURITY;

INSERT INTO "permissions" ("code", "scope", "description")
VALUES ('ai_insights.manage', 'BUSINESS', 'Run inventory insight analysis and change its thresholds.')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" = 'ai_insights.manage'
WHERE r."scope" = 'BUSINESS' AND r."code" = 'OWNER'
ON CONFLICT DO NOTHING;

COMMIT;
