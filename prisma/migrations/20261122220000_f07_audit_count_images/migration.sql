-- F07: evidence photos for stock audit counts.
--
-- A counter who finds broken goods documents it with photos. The photos hang off the count row
-- (stock_audit_item_counts) rather than the audit item, because the two counters count
-- independently and must not see each other's photos.
-- Idempotent so it can be re-run safely on a database that already has part of it.

CREATE TABLE IF NOT EXISTS "stock_audit_item_count_images" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "count_id" UUID NOT NULL,
  "storage_path" VARCHAR(500) NOT NULL,
  "mime_type" VARCHAR(50) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "note" VARCHAR(500),
  "uploaded_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(6),
  "deleted_by" UUID,

  CONSTRAINT "stock_audit_item_count_images_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_audit_item_count_images_size_bytes_check" CHECK ("size_bytes" > 0),
  CONSTRAINT "stock_audit_item_count_images_mime_type_check"
    CHECK ("mime_type" IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT "stock_audit_item_count_images_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "stock_audit_item_count_images_count_id_fkey"
    FOREIGN KEY ("count_id") REFERENCES "stock_audit_item_counts"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "stock_audit_item_count_images_uploaded_by_fkey"
    FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "stock_audit_item_count_images_deleted_by_fkey"
    FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_stock_audit_item_count_images_count"
  ON "stock_audit_item_count_images" ("business_id", "count_id");

-- Only the backend (service role) reads or writes this table; no client policies are created.
ALTER TABLE "stock_audit_item_count_images" ENABLE ROW LEVEL SECURITY;
