const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { Client } = require("pg");
require("ts-node/register/transpile-only");
const { upsertImportedCatalog } = require("../src/modules/purchases/supplier-import-catalog.ts");

// Opt in with a database URL. All fixtures live in a connection-local temporary
// table that shadows supplier_products; existing application tables are untouched.
test("PostgreSQL: bulk catalog upsert preserves rules, tenant boundaries and statement atomicity", {
  skip: !process.env.SUPPLIER_IMPORT_TEST_DATABASE_URL,
}, async t => {
  const url = new URL(process.env.SUPPLIER_IMPORT_TEST_DATABASE_URL);
  url.searchParams.delete("sslmode");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const client = new Client({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMPORARY TABLE supplier_products (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      business_id uuid NOT NULL, supplier_id uuid NOT NULL, variant_id uuid NOT NULL,
      supplier_sku varchar(100), supplier_product_name varchar(255),
      supply_price numeric(12,2) NOT NULL CHECK (supply_price >= 0),
      min_order_qty integer NOT NULL DEFAULT 1, order_multiple integer NOT NULL DEFAULT 1,
      lead_time_days integer, is_preferred boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      price_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      note text, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (business_id, supplier_id, variant_id)
    ) ON COMMIT DROP`);
    const businessId = randomUUID(); const otherBusiness = randomUUID(); const supplierId = randomUUID();
    const lines = Array.from({ length: 500 }, (_, i) => ({ variantId: randomUUID(), supplierSku: `NCC-${i}`,
      name: i === 0 ? "Kem dưỡng O'Neil ); DROP TABLE supplier_products; --" : `Sản phẩm ${i}`,
      price: i === 499 ? "9999999999.99" : "12345.67" }));
    for (const [tenant, variantId, active, preferred] of [
      [businessId, lines[0].variantId, true, true],
      [businessId, lines[1].variantId, false, false],
      [otherBusiness, lines[0].variantId, true, false],
    ]) {
      await client.query(`INSERT INTO supplier_products
        (business_id, supplier_id, variant_id, supply_price, min_order_qty, order_multiple,
         lead_time_days, is_preferred, is_active, note, created_at, updated_at)
        VALUES ($1,$2,$3,1,12,6,3,$4,$5,'Keep original rules','2026-01-01','2026-01-01')`,
      [tenant, supplierId, variantId, preferred, active]);
    }
    let writes = 0;
    const tx = { $executeRaw: async (strings, ...values) => {
      writes++;
      const text = strings.reduce((sql, part, i) => sql + (i ? `$${i}` : "") + part, "");
      assert.equal(text.includes(lines[0].name), false);
      return (await client.query(text, values)).rowCount;
    } };
    const started = performance.now();
    await upsertImportedCatalog(tx, businessId, supplierId, lines);
    t.diagnostic(`500 catalog rows upserted in one statement (${Math.round(performance.now() - started)} ms)`);
    assert.equal(writes, 1);
    const all = (await client.query("SELECT * FROM supplier_products")).rows;
    assert.equal(all.length, 501);
    const own = all.filter(row => row.business_id === businessId);
    assert.equal(own.length, 500);
    const byId = new Map(own.map(row => [row.variant_id, row]));
    for (const line of lines) {
      const row = byId.get(line.variantId);
      assert.equal(row.supplier_id, supplierId); assert.equal(row.supplier_sku, line.supplierSku);
      assert.equal(row.supplier_product_name, line.name); assert.equal(row.supply_price, line.price);
      assert.equal(row.is_active, true);
    }
    for (const line of lines.slice(0, 2)) {
      const row = byId.get(line.variantId);
      assert.equal(row.min_order_qty, 12); assert.equal(row.order_multiple, 6);
      assert.equal(row.lead_time_days, 3); assert.equal(row.note, "Keep original rules");
      assert.equal(row.created_at.toISOString(), "2026-01-01T00:00:00.000Z");
      assert.ok(row.updated_at > row.created_at);
    }
    assert.equal(byId.get(lines[0].variantId).is_preferred, true);
    const foreign = all.find(row => row.business_id === otherBusiness);
    assert.equal(foreign.supply_price, "1.00");
    assert.equal(foreign.updated_at.toISOString(), "2026-01-01T00:00:00.000Z");
    await upsertImportedCatalog(tx, businessId, supplierId, lines);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM supplier_products")).rows[0].count, 501);

    await client.query("SAVEPOINT before_bad_import");
    await assert.rejects(upsertImportedCatalog(tx, businessId, supplierId, [
      { ...lines[0], variantId: randomUUID() }, { ...lines[1], price: "-1" },
    ]), error => error.code === "23514");
    await client.query("ROLLBACK TO SAVEPOINT before_bad_import");
    assert.equal((await client.query("SELECT count(*)::int AS count FROM supplier_products")).rows[0].count, 501);
    assert.equal((await client.query("SELECT supply_price FROM supplier_products WHERE business_id=$1 AND variant_id=$2", [businessId, lines[1].variantId])).rows[0].supply_price, lines[1].price);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});
