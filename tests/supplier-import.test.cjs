const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");
const ExcelJS = require("exceljs");
const { Prisma } = require("@prisma/client");
const businessId = "11111111-1111-4111-8111-111111111111";
const supplierId = "22222222-2222-4222-8222-222222222222";
let supplier; let variants; let writes;
const db = {
  supplier: { findFirst: async args => { assert.deepEqual(args.where, { businessId, id: supplierId }); return supplier; } },
  productVariant: {
    findMany: async args => { assert.equal(args.where.businessId, businessId); return variants; },
    create: async args => { writes.push(["variant", args]); return { id: "new-variant" }; },
  },
  productTemplate: { findMany: async () => [], upsert: async args => { writes.push(["template", args]); return { id: "template", isActive: true, hasLotTracking: false, unitOfMeasure: args.create.unitOfMeasure }; } },
  supplierProduct: { upsert: async args => { writes.push(["catalog", args]); return args.create; } },
  $transaction: async operation => operation(db),
};
const dbPath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: db } };
const { parseSupplierFile } = require("../src/modules/purchases/supplier-import.parser.ts");
const { previewSupplierImport, confirmSupplierImport } = require("../src/modules/purchases/supplier-import.service.ts");
const csv = (value) => ({ originalname: "supplier.csv", buffer: Buffer.from(value) });
const file = () => csv("SKU,Tên sản phẩm,Giá chào,Đơn vị tính\n0001,Sữa,12500,Hộp");
beforeEach(() => { supplier = { isActive: true }; variants = []; writes = []; });

test("CSV preserves leading-zero SKU and detects Vietnamese columns", async () => {
  const result = await parseSupplierFile(file());
  assert.deepEqual(result.mapping, { sku: 1, name: 2, price: 3, unit: 4 });
  assert.equal(result.items[0].sku, "0001"); assert.equal(result.items[0].price, "12500.00");
  assert.equal(result.items[0].unit, "Hộp"); assert.equal(result.items[0].error, undefined);
});
test("custom columns, semicolon CSV, invalid mapping, duplicate SKU and invalid prices", async () => {
  const custom = csv("A;B;C\n001;Milk;10.50");
  assert.equal((await parseSupplierFile(custom)).issues.length, 3);
  assert.equal((await parseSupplierFile(custom, { sku: 1, name: 2, price: 3 })).items[0].price, "10.50");
  await assert.rejects(parseSupplierFile(custom, { sku: 1, name: 1, price: 3 }), e => e.statusCode === 400);
  for (const price of ["-1", "1.001", "10000000000", "1e3"]) {
    const parsed = await parseSupplierFile(csv(`SKU,Name,Price\nA,Milk,${price}`));
    assert.ok(parsed.items[0].error);
  }
  const repeated = await parseSupplierFile(csv("SKU,Name,Price\nA,Milk,10\nA,Milk,20"));
  assert.match(repeated.items[1].error, /lặp/);
});
test("XLSX accepts numeric prices and rejects formula cells", async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Products");
  sheet.addRow(["SKU", "Name", "Price"]); sheet.addRow(["001", "Milk", 12.5]);
  sheet.addRow(["002", "Tea", { formula: "1+1", result: 2 }]);
  const parsed = await parseSupplierFile({ originalname: "products.xlsx", buffer: Buffer.from(await book.xlsx.writeBuffer()) });
  assert.equal(parsed.items[0].price, "12.50"); assert.match(parsed.items[1].error, /công thức/);
});
test("500-row limit and unsupported files are rejected", async () => {
  await assert.rejects(parseSupplierFile(csv("SKU,Name,Price\n" + Array.from({ length: 501 }, (_, i) => `S${i},Milk,10`).join("\n"))), e => e.statusCode === 400);
  await assert.rejects(parseSupplierFile({ originalname: "bad.xlsx", buffer: Buffer.from("bad") }), e => e.statusCode === 400);
});
test("preview writes nothing; confirmation creates a product and tenant-scoped catalog without stock", async () => {
  const preview = await previewSupplierImport(businessId, supplierId, file());
  assert.equal(preview.valid, true); assert.equal(preview.items[0].action, "create"); assert.equal(writes.length, 0);
  const result = await confirmSupplierImport(businessId, supplierId, file(), preview.mapping, preview.digest);
  assert.deepEqual(result, { created: 1, linked: 0, updated: 0, total: 1 });
  assert.equal(writes.find(([key]) => key === "variant")[1].data.basePrice, 0);
  assert.deepEqual(writes.find(([key]) => key === "catalog")[1].where.businessId_supplierId_variantId, { businessId, supplierId, variantId: "new-variant" });
});
test("existing SKU updates supplier price without changing store price or name", async () => {
  variants = [{ id: "existing", sku: "0001", isActive: true, template: { name: "Internal name", isActive: true }, supplierProducts: [{ supplyPrice: new Prisma.Decimal(10), updatedAt: new Date("2026-01-01") }] }];
  const preview = await previewSupplierImport(businessId, supplierId, file());
  assert.equal(preview.items[0].action, "update"); assert.equal(preview.items[0].currentName, "Internal name");
  const result = await confirmSupplierImport(businessId, supplierId, file(), preview.mapping, preview.digest);
  assert.equal(result.updated, 1); assert.deepEqual(writes.map(([key]) => key), ["catalog"]);
});
test("changed file or catalog, row errors, missing supplier and retired supplier block writes", async () => {
  const preview = await previewSupplierImport(businessId, supplierId, file());
  await assert.rejects(confirmSupplierImport(businessId, supplierId, csv("SKU,Name,Price,Unit\n0001,Milk,99,Hộp"), preview.mapping, preview.digest), e => e.statusCode === 409);
  variants = [{ id: "existing", sku: "0001", isActive: true, template: { name: "Milk", isActive: true }, supplierProducts: [] }];
  await assert.rejects(confirmSupplierImport(businessId, supplierId, file(), preview.mapping, preview.digest), e => e.statusCode === 409);
  const invalid = csv("SKU,Name,Price\nA,Milk,-10"); const bad = await previewSupplierImport(businessId, supplierId, invalid);
  await assert.rejects(confirmSupplierImport(businessId, supplierId, invalid, bad.mapping, bad.digest), e => e.statusCode === 400);
  supplier = null; await assert.rejects(previewSupplierImport(businessId, supplierId, file()), e => e.statusCode === 404);
  supplier = { isActive: false }; await assert.rejects(previewSupplierImport(businessId, supplierId, file()), e => e.statusCode === 409);
  assert.equal(writes.length, 0);
});
