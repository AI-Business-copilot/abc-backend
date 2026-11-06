ALTER TABLE "cash_shift_handoffs"
  ADD COLUMN "status" VARCHAR(30) NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "explanation" TEXT,
  ADD COLUMN "reviewed_by" UUID,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "reviewer_note" TEXT;

ALTER TABLE "cash_shift_handoffs"
  ADD CONSTRAINT "cash_shift_handoffs_status_check"
  CHECK ("status" IN ('PENDING_REVIEW', 'NEEDS_EXPLANATION', 'APPROVED'));

ALTER TABLE "cash_shift_handoffs"
  ADD CONSTRAINT "cash_shift_handoffs_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE "cash_shift_close_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "shift_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "expected_cash" DECIMAL(12,2) NOT NULL,
  "actual_cash" DECIMAL(12,2) NOT NULL,
  "difference_cash" DECIMAL(12,2) NOT NULL,
  "is_matched" BOOLEAN NOT NULL,
  "explanation" TEXT,
  "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING_REVIEW',
  "submitted_by" UUID NOT NULL,
  "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_by" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  "reviewer_note" TEXT,

  CONSTRAINT "cash_shift_close_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_shift_close_reviews_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "cash_shift_close_reviews_status_check"
    CHECK ("status" IN ('PENDING_REVIEW', 'NEEDS_EXPLANATION', 'APPROVED')),
  CONSTRAINT "cash_shift_close_reviews_amounts_check"
    CHECK ("expected_cash" >= 0 AND "actual_cash" >= 0),
  CONSTRAINT "cash_shift_close_reviews_difference_check"
    CHECK ("difference_cash" = "actual_cash" - "expected_cash"),
  CONSTRAINT "cash_shift_close_reviews_match_check"
    CHECK ("is_matched" = ("difference_cash" = 0)),
  CONSTRAINT "cash_shift_close_reviews_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_shift_close_reviews_shift_id_fkey"
    FOREIGN KEY ("shift_id") REFERENCES "cash_shifts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_shift_close_reviews_submitted_by_fkey"
    FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_shift_close_reviews_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_shift_close_reviews_shift_revision_key" UNIQUE ("shift_id", "revision")
);

CREATE INDEX "idx_cash_shift_close_reviews_business_status"
  ON "cash_shift_close_reviews" ("business_id", "status", "submitted_at" DESC);

ALTER TABLE "cash_shift_close_reviews" ENABLE ROW LEVEL SECURITY;

CREATE TABLE "cash_shift_handoff_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "handoff_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "explanation" TEXT NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING_REVIEW',
  "submitted_by" UUID NOT NULL,
  "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_by" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  "reviewer_note" TEXT,

  CONSTRAINT "cash_shift_handoff_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_shift_handoff_reviews_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "cash_shift_handoff_reviews_status_check"
    CHECK ("status" IN ('PENDING_REVIEW', 'NEEDS_EXPLANATION', 'APPROVED')),
  CONSTRAINT "cash_shift_handoff_reviews_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_shift_handoff_reviews_handoff_id_fkey"
    FOREIGN KEY ("handoff_id") REFERENCES "cash_shift_handoffs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_shift_handoff_reviews_submitted_by_fkey"
    FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_shift_handoff_reviews_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_shift_handoff_reviews_revision_key" UNIQUE ("handoff_id", "revision")
);

CREATE INDEX "idx_cash_shift_handoff_reviews_business_status"
  ON "cash_shift_handoff_reviews" ("business_id", "status", "submitted_at" DESC);

ALTER TABLE "cash_shift_handoff_reviews" ENABLE ROW LEVEL SECURITY;

UPDATE "cash_shift_handoffs"
   SET "status" = 'PENDING_REVIEW',
       "explanation" = COALESCE("explanation", 'Chênh lệch bàn giao được ghi nhận trước khi bật luồng duyệt.')
 WHERE "difference_cash" <> 0;

INSERT INTO "cash_shift_handoff_reviews"
  ("business_id", "handoff_id", "revision", "explanation", "status", "submitted_by")
SELECT "business_id", "id", 1, "explanation", 'PENDING_REVIEW', "recorded_by"
  FROM "cash_shift_handoffs"
 WHERE "difference_cash" <> 0
ON CONFLICT ("handoff_id", "revision") DO NOTHING;

INSERT INTO "permissions" ("code", "scope", "description")
VALUES
  ('cash.shift.reconcile', 'BUSINESS', 'View theoretical cash balances and exact cash differences.'),
  ('cash.shift.review', 'BUSINESS', 'Review and decide cash shift closing and handoff requests.'),
  ('cash.shift.withdraw', 'BUSINESS', 'Withdraw cash from the register into a safe or bank.')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p
  ON p."code" IN ('cash.shift.reconcile', 'cash.shift.review', 'cash.shift.withdraw')
WHERE r."code" = 'OWNER'
ON CONFLICT DO NOTHING;
