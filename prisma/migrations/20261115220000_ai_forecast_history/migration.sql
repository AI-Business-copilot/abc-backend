BEGIN;

CREATE TABLE "ai_forecast_history" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "variant_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "as_of" DATE NOT NULL,
  "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "result" JSONB NOT NULL,
  CONSTRAINT "ai_forecast_history_variant_fkey" FOREIGN KEY ("business_id", "variant_id")
    REFERENCES "product_variants"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "uq_ai_forecast_history_run" ON "ai_forecast_history"("business_id", "variant_id", "run_id");
CREATE INDEX "idx_ai_forecast_history_variant" ON "ai_forecast_history"("business_id", "variant_id", "issued_at" DESC);
ALTER TABLE "ai_forecast_history" ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION "reject_ai_forecast_history_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Forecast history snapshots cannot be updated';
END;
$$;
CREATE TRIGGER "ai_forecast_history_immutable" BEFORE UPDATE ON "ai_forecast_history"
  FOR EACH ROW EXECUTE FUNCTION "reject_ai_forecast_history_update"();

COMMIT;
