-- One physical register per business: prevent overlapping open shifts.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cash_shifts_one_open_per_business"
  ON "cash_shifts" ("business_id")
  WHERE "status" = 'OPEN';

CREATE INDEX IF NOT EXISTS "idx_cash_transactions_shift_created_at"
  ON "cash_transactions" ("shift_id", "created_at");

ALTER TABLE "cash_transactions"
  ADD CONSTRAINT "cash_transactions_type_check"
  CHECK ("transaction_type" IN ('IN', 'OUT')) NOT VALID;

ALTER TABLE "cash_transactions"
  ADD CONSTRAINT "cash_transactions_amount_check"
  CHECK ("amount" > 0) NOT VALID;

ALTER TABLE "cash_shifts"
  ADD CONSTRAINT "cash_shifts_opening_cash_check"
  CHECK ("opening_cash" >= 0) NOT VALID;

ALTER TABLE "cash_shifts"
  ADD CONSTRAINT "cash_shifts_actual_cash_check"
  CHECK ("actual_cash" IS NULL OR "actual_cash" >= 0) NOT VALID;

ALTER TABLE "cash_shifts"
  ADD COLUMN IF NOT EXISTS "reconciliation_status" VARCHAR(30) NOT NULL DEFAULT 'INCOMPLETE_DATA';

ALTER TABLE "cash_shifts"
  ADD CONSTRAINT "cash_shifts_reconciliation_status_check"
  CHECK ("reconciliation_status" IN ('INCOMPLETE_DATA', 'RECONCILED')) NOT VALID;

CREATE TABLE IF NOT EXISTS "cash_shift_handoffs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "previous_shift_id" UUID NOT NULL,
  "next_shift_id" UUID NOT NULL,
  "handed_over_cash" DECIMAL(12,2) NOT NULL,
  "received_cash" DECIMAL(12,2) NOT NULL,
  "difference_cash" DECIMAL(12,2) NOT NULL,
  "recorded_by" UUID NOT NULL,
  "notes" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cash_shift_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_shift_handoffs_distinct_shifts_check"
    CHECK ("previous_shift_id" <> "next_shift_id"),
  CONSTRAINT "cash_shift_handoffs_nonnegative_amounts_check"
    CHECK ("handed_over_cash" >= 0 AND "received_cash" >= 0),
  CONSTRAINT "cash_shift_handoffs_difference_check"
    CHECK ("difference_cash" = "received_cash" - "handed_over_cash"),
  CONSTRAINT "cash_shift_handoffs_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_shift_handoffs_previous_shift_id_fkey"
    FOREIGN KEY ("previous_shift_id") REFERENCES "cash_shifts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_shift_handoffs_next_shift_id_fkey"
    FOREIGN KEY ("next_shift_id") REFERENCES "cash_shifts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_shift_handoffs_recorded_by_fkey"
    FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_cash_shift_handoffs_previous_shift"
  ON "cash_shift_handoffs" ("previous_shift_id");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_cash_shift_handoffs_next_shift"
  ON "cash_shift_handoffs" ("next_shift_id");

CREATE INDEX IF NOT EXISTS "idx_cash_shift_handoffs_business_created_at"
  ON "cash_shift_handoffs" ("business_id", "created_at" DESC);

ALTER TABLE "cash_shift_handoffs" ENABLE ROW LEVEL SECURITY;

INSERT INTO "permissions" ("code", "scope", "description")
VALUES
  ('cash.shift.read', 'BUSINESS', 'View cash shifts, cash movements, and handoffs.'),
  ('cash.shift.manage', 'BUSINESS', 'Open and close cash shifts and record cash movements.')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN ('cash.shift.read', 'cash.shift.manage')
WHERE r."code" IN ('OWNER', 'STAFF')
ON CONFLICT DO NOTHING;
