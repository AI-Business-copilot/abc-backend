import type { Prisma } from "@prisma/client";

type CatalogLine = { variantId: string; supplierSku: string; name: string; price: string };

// One parameterized statement for the entire file. Only imported catalog fields
// change on conflict; purchasing rules, preferred supplier and notes stay intact.
export async function upsertImportedCatalog(tx: Prisma.TransactionClient, businessId: string, supplierId: string, lines: CatalogLine[]) {
  if (!lines.length) return;
  const payload = JSON.stringify(lines);
  await tx.$executeRaw`
    INSERT INTO supplier_products (
      business_id, supplier_id, variant_id, supplier_sku,
      supplier_product_name, supply_price, is_active, price_updated_at, updated_at
    )
    SELECT ${businessId}::uuid, ${supplierId}::uuid, item."variantId",
      item."supplierSku", item.name, item.price, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM jsonb_to_recordset(${payload}::jsonb) AS item(
      "variantId" uuid, "supplierSku" text, name text, price numeric(12, 2)
    )
    ORDER BY item."variantId"
    ON CONFLICT (business_id, supplier_id, variant_id) DO UPDATE SET
      supplier_sku = EXCLUDED.supplier_sku,
      supplier_product_name = EXCLUDED.supplier_product_name,
      supply_price = EXCLUDED.supply_price,
      is_active = EXCLUDED.is_active,
      price_updated_at = EXCLUDED.price_updated_at,
      updated_at = EXCLUDED.updated_at
  `;
}
