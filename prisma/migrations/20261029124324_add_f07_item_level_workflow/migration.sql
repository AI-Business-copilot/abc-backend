-- Add audit_type column to stock_audits
ALTER TABLE "stock_audits" 
ADD COLUMN "audit_type" VARCHAR(30) NOT NULL DEFAULT 'CATEGORY_AUDIT';

-- Add CHECK constraint for audit_type
ALTER TABLE "stock_audits"
ADD CONSTRAINT "chk_audit_type" CHECK ("audit_type" IN ('NEW_LOTS', 'RE_AUDIT', 'CATEGORY_AUDIT'));

-- Add is_locked_for_audit column to product_lots for RE_AUDIT scope freeze
ALTER TABLE "product_lots"
ADD COLUMN "is_locked_for_audit" BOOLEAN NOT NULL DEFAULT false;

-- Add item_status and related columns to stock_audit_items
ALTER TABLE "stock_audit_items"
ADD COLUMN "item_status" VARCHAR(30) NOT NULL DEFAULT 'IN_PROGRESS',
ADD COLUMN "assigned_to_user_id" UUID,
ADD COLUMN "submitted_at" TIMESTAMPTZ,
ADD COLUMN "submitted_by" UUID,
ADD COLUMN "approved_at" TIMESTAMPTZ,
ADD COLUMN "approved_by" UUID;

-- Add CHECK constraint for item_status
ALTER TABLE "stock_audit_items"
ADD CONSTRAINT "chk_item_status" CHECK ("item_status" IN ('IN_PROGRESS', 'PENDING_APPROVAL', 'APPROVED'));

-- Add foreign key constraints
ALTER TABLE "stock_audit_items"
ADD CONSTRAINT "fk_stock_audit_items_assigned_to_user_id" 
  FOREIGN KEY ("assigned_to_user_id") 
  REFERENCES "users"("id") 
  ON DELETE RESTRICT 
  ON UPDATE NO ACTION,
ADD CONSTRAINT "fk_stock_audit_items_submitted_by_user_id"
  FOREIGN KEY ("submitted_by")
  REFERENCES "users"("id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION,
ADD CONSTRAINT "fk_stock_audit_items_approved_by_user_id"
  FOREIGN KEY ("approved_by")
  REFERENCES "users"("id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;

-- Create index for item status queries (frequent query on audit details)
CREATE INDEX "idx_stock_audit_items_item_status" 
ON "stock_audit_items"("audit_id", "item_status");

-- Create index for assigned staff queries
CREATE INDEX "idx_stock_audit_items_assigned_to_user" 
ON "stock_audit_items"("assigned_to_user_id", "item_status");
