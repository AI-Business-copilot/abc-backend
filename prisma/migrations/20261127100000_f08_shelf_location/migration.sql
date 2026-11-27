-- F08: warehouse shelf and location.
--
-- The warehouse needs to know where a lot physically sits: "Ke A2 - Tang 3 - O 04". The code
-- had no notion of a shelf at all, so the location could not be recorded, shown on the F08 lot
-- tree, or used to scope an F07 stock audit.
--
-- Two tables: inventory_shelves holds the shelf (code A2), inventory_shelf_cells holds one
-- position on it (level 3, slot 4). A cell is created on demand when a lot is assigned to it,
-- so the staff only ever picks a shelf, a level and a slot.
--
-- The location lives on product_lot_items, not on product_lots: one batch can hold several
-- variants that sit in different places.
--
-- Idempotent so it can be re-run safely on a database that already has part of it.

CREATE TABLE IF NOT EXISTS "inventory_shelves" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "code" VARCHAR(50) NOT NULL,
  "name" VARCHAR(255),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) DEFAULT now(),

  CONSTRAINT "inventory_shelves_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_inventory_shelf_tenant_code"
  ON "inventory_shelves" ("business_id", "code");

ALTER TABLE "inventory_shelves" DROP CONSTRAINT IF EXISTS "inventory_shelves_business_id_fkey";
ALTER TABLE "inventory_shelves"
  ADD CONSTRAINT "inventory_shelves_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE IF NOT EXISTS "inventory_shelf_cells" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "shelf_id" UUID NOT NULL,
  "level" INTEGER NOT NULL,
  "slot" INTEGER NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) DEFAULT now(),

  CONSTRAINT "inventory_shelf_cells_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_inventory_shelf_cell_position"
  ON "inventory_shelf_cells" ("shelf_id", "level", "slot");
CREATE INDEX IF NOT EXISTS "idx_inventory_shelf_cells_business"
  ON "inventory_shelf_cells" ("business_id");

ALTER TABLE "inventory_shelf_cells" DROP CONSTRAINT IF EXISTS "inventory_shelf_cells_business_id_fkey";
ALTER TABLE "inventory_shelf_cells"
  ADD CONSTRAINT "inventory_shelf_cells_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "inventory_shelf_cells" DROP CONSTRAINT IF EXISTS "inventory_shelf_cells_shelf_id_fkey";
ALTER TABLE "inventory_shelf_cells"
  ADD CONSTRAINT "inventory_shelf_cells_shelf_id_fkey"
  FOREIGN KEY ("shelf_id") REFERENCES "inventory_shelves"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- The location of a lot item.
ALTER TABLE "product_lot_items" ADD COLUMN IF NOT EXISTS "shelf_cell_id" UUID;
CREATE INDEX IF NOT EXISTS "idx_product_lot_items_business_shelf_cell"
  ON "product_lot_items" ("business_id", "shelf_cell_id");
ALTER TABLE "product_lot_items" DROP CONSTRAINT IF EXISTS "product_lot_items_shelf_cell_id_fkey";
ALTER TABLE "product_lot_items"
  ADD CONSTRAINT "product_lot_items_shelf_cell_id_fkey"
  FOREIGN KEY ("shelf_cell_id") REFERENCES "inventory_shelf_cells"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- F07: the scope of an audit. The columns scope_type already existed but nothing ever wrote
-- them, so "Theo ke" and "Theo danh muc" were dead options. These two columns record which
-- shelf cell or which category the audit covers.
ALTER TABLE "stock_audits" ADD COLUMN IF NOT EXISTS "shelf_cell_id" UUID;
ALTER TABLE "stock_audits" ADD COLUMN IF NOT EXISTS "category_id" UUID;
ALTER TABLE "stock_audits" DROP CONSTRAINT IF EXISTS "stock_audits_shelf_cell_id_fkey";
ALTER TABLE "stock_audits"
  ADD CONSTRAINT "stock_audits_shelf_cell_id_fkey"
  FOREIGN KEY ("shelf_cell_id") REFERENCES "inventory_shelf_cells"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "stock_audits" DROP CONSTRAINT IF EXISTS "stock_audits_category_id_fkey";
ALTER TABLE "stock_audits"
  ADD CONSTRAINT "stock_audits_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- F07: the permission that lets a member manage the shelves.
INSERT INTO "permissions" ("code", "scope", "description")
SELECT 'inventory.shelf.manage', 'BUSINESS', 'Create and manage warehouse shelves and their cells.'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "code" = 'inventory.shelf.manage');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" = 'inventory.shelf.manage'
WHERE r."code" IN ('OWNER', 'STAFF')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
  );
