const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");
const ExcelJS = require("exceljs");
const { Prisma } = require("@prisma/client");
const { randomUUID } = require("node:crypto");
const businessId = "11111111-1111-4111-8111-111111111111";
const supplierId = "22222222-2222-4222-8222-222222222222";
let supplier; let variants; let templates; let writes; let calls; let catalogError;
const db = {
  supplier: { findFirst: async args => { calls.push("supplier.read"); assert.deepEqual(args.where, { businessId, id: supplierId }); return supplier; } },
  productVariant: {
    findMany: async args => { calls.push("variants.read"); assert.equal(args.where.businessId, businessId); return variants.filter(row => args.where.sku.in.includes(row.sku)); },
    createManyAndReturn: async args => {
      calls.push("variants.write"); writes.push(["variants", args]);
      const rows = args.data.map(data => ({ ...data, id: randomUUID(), isActive: true,
        template: templates.find(row => row.id === data.templateId), supplierProducts: [] }));
      variants.push(...rows);
      return rows.map(({ id, sku }) => ({ id, sku })).reverse();
    },
  },
  productTemplate: {
    findMany: async args => { calls.push("templates.read"); assert.equal(args.where.businessId, businessId); return templates.filter(row => args.where.name.in.includes(row.name)); },
    createManyAndReturn: async args => {
      calls.push("templates.write"); writes.push(["templates", args]);
      const rows = args.data.map(data => ({ ...data, id: randomUUID(), isActive: true, hasLotTracking: false }));
      assert.equal(new Set([...templates, ...rows].map(row => row.name)).size, templates.length + rows.length);
      templates.push(...rows);
      return [...rows].reverse();
    },
  },
  $executeRaw: async (strings, ...parameters) => {
    calls.push("catalog.write");
    assert.equal(parameters[0], businessId); assert.equal(parameters[1], supplierId);
    const data = JSON.parse(parameters[2]);
    writes.push(["catalog", { businessId: parameters[0], supplierId: parameters[1], data, query: strings.join("?") }]);
    if (catalogError) {
      const error = catalogError;
      if (error.code === "P2034") catalogError = undefined;
      throw error;
    }
    for (const line of data) {
      const variant = variants.find(row => row.id === line.variantId);
      assert.ok(variant, "Each catalog line must reference its matching SKU, even when RETURNING order changes");
      variant.supplierProducts = [{ ...variant.supplierProducts[0], supplyPrice: new Prisma.Decimal(line.price), updatedAt: new Date() }];
    }
    return data.length;
  },
  $transaction: async (operation, options) => {
    assert.equal(options.isolationLevel, "Serializable");
    const oldTemplates = [...templates];
    const oldVariants = variants.map(row => ({ ...row, supplierProducts: [...row.supplierProducts] }));
    try { return await operation(db); }
    catch (error) { templates = oldTemplates; variants = oldVariants; throw error; }
  },
};
const dbPath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: db } };
const { parseSupplierFile } = require("../src/modules/purchases/supplier-import.parser.ts");
const { previewSupplierImport, confirmSupplierImport } = require("../src/modules/purchases/supplier-import.service.ts");
const csv = (value) => ({ originalname: "supplier.csv", buffer: Buffer.from(value) });
const file = () => csv("SKU,Tên sản phẩm,Giá chào,Đơn vị tính\n0001,Sữa,12500,Hộp");
beforeEach(() => { supplier = { isActive: true }; variants = []; templates = []; writes = []; calls = []; catalogError = undefined; });

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
  assert.equal(writes.find(([key]) => key === "variants")[1].data[0].basePrice, 0);
  const catalog = writes.find(([key]) => key === "catalog")[1];
  assert.equal(catalog.businessId, businessId); assert.equal(catalog.supplierId, supplierId);
  assert.equal(catalog.data[0].variantId, variants[0].id);
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

for (const count of [50, 500]) test(`${count} new SKUs use a bounded number of database calls and keep prices matched to SKUs`, async () => {
  const batch = csv("SKU,Name,Price\n" + Array.from({ length: count }, (_, i) => `SKU-${i},Product ${i},${i + 1}.25`).join("\n"));
  const preview = await previewSupplierImport(businessId, supplierId, batch);
  calls = [];
  const result = await confirmSupplierImport(businessId, supplierId, batch, preview.mapping, preview.digest);
  assert.deepEqual(result, { created: count, linked: 0, updated: 0, total: count });
  assert.equal(calls.length, 6, "Service database operations must not grow per imported row");
  assert.equal(templates.length, count); assert.equal(variants.length, count);
  for (let i = 0; i < count; i++) {
    const variant = variants.find(row => row.sku === `SKU-${i}`);
    assert.equal(variant.template.name, `Product ${i}`);
    assert.equal(variant.supplierProducts[0].supplyPrice.toFixed(2), `${i + 1}.25`);
    assert.equal(variant.basePrice, 0); assert.equal(variant.costPrice, 0);
    assert.equal(variant.businessId, businessId);
  }
  const catalog = writes.find(([key]) => key === "catalog")[1];
  assert.match(catalog.query, /ON CONFLICT \(business_id, supplier_id, variant_id\)/);
  assert.equal(catalog.query.includes("Product 0"), false, "Untrusted text belongs in bound parameters");
});

test("new SKUs share one template per name and reuse compatible existing templates", async () => {
  const existingTemplate = { id: randomUUID(), businessId, name: "Existing product", unitOfMeasure: "Cái", isActive: true, hasLotTracking: false };
  templates = [existingTemplate];
  const batch = csv("SKU,Name,Price\nA,New product,10\nB,New product,20\nC,Existing product,30");
  const preview = await previewSupplierImport(businessId, supplierId, batch);
  await confirmSupplierImport(businessId, supplierId, batch, preview.mapping, preview.digest);
  assert.equal(templates.length, 2);
  assert.equal(variants[0].templateId, variants[1].templateId);
  assert.equal(variants[2].templateId, existingTemplate.id);
  assert.equal(writes.find(([key]) => key === "templates")[1].data.length, 1);
});

test("mixed imports count creates, links and updates correctly; reimports create no duplicates", async () => {
  variants = [
    { id: randomUUID(), sku: "LINK", isActive: true, template: { name: "Original linked name", isActive: true }, supplierProducts: [] },
    { id: randomUUID(), sku: "UPDATE", isActive: true, template: { name: "Original updated name", isActive: true },
      supplierProducts: [{ supplyPrice: new Prisma.Decimal(10), updatedAt: new Date("2026-01-01"), note: "Keep note", minOrderQty: 12 }] },
  ];
  const batch = csv("SKU,Name,Price,Ma hang NCC\nNEW,New product,10.10,N-1\nLINK,Supplier linked name,20.20,L-1\nUPDATE,Supplier updated name,30.30,U-1");
  const preview = await previewSupplierImport(businessId, supplierId, batch);
  assert.deepEqual(await confirmSupplierImport(businessId, supplierId, batch, preview.mapping, preview.digest), { created: 1, linked: 1, updated: 1, total: 3 });
  assert.equal(variants[0].template.name, "Original linked name");
  assert.equal(variants[1].supplierProducts[0].note, "Keep note");
  assert.equal(variants[1].supplierProducts[0].minOrderQty, 12);
  const second = await previewSupplierImport(businessId, supplierId, batch);
  calls = []; writes = [];
  assert.deepEqual(await confirmSupplierImport(businessId, supplierId, batch, second.mapping, second.digest), { created: 0, linked: 0, updated: 3, total: 3 });
  assert.equal(variants.length, 3); assert.equal(templates.length, 1);
  assert.deepEqual(writes.map(([key]) => key), ["catalog"]);
  assert.equal(calls.length, 4);
});

test("catalog failure rolls back newly created templates and variants", async () => {
  const preview = await previewSupplierImport(businessId, supplierId, file());
  catalogError = new Error("Catalog write failed");
  await assert.rejects(confirmSupplierImport(businessId, supplierId, file(), preview.mapping, preview.digest), error => error === catalogError);
  assert.equal(templates.length, 0); assert.equal(variants.length, 0);
});

test("serialization conflicts retry the whole batch without leaving duplicate products", async () => {
  const preview = await previewSupplierImport(businessId, supplierId, file());
  catalogError = Object.assign(new Error("Serialization conflict"), { code: "P2034" });
  assert.deepEqual(await confirmSupplierImport(businessId, supplierId, file(), preview.mapping, preview.digest), { created: 1, linked: 0, updated: 0, total: 1 });
  assert.equal(templates.length, 1); assert.equal(variants.length, 1);
  assert.equal(calls.filter(call => call === "catalog.write").length, 2);
});

test("incompatible or changed templates prevent the entire batch from being written", async () => {
  for (const change of [{ isActive: false }, { hasLotTracking: true }, { unitOfMeasure: "Chai" }]) {
    templates = [{ id: randomUUID(), businessId, name: "Sữa", unitOfMeasure: "Hộp", isActive: true, hasLotTracking: false, ...change }];
    const bad = await previewSupplierImport(businessId, supplierId, file());
    assert.equal(bad.valid, false);
    await assert.rejects(confirmSupplierImport(businessId, supplierId, file(), bad.mapping, bad.digest), error => error.statusCode === 400);
  }
  templates = [];
  const preview = await previewSupplierImport(businessId, supplierId, file());
  templates = [{ id: randomUUID(), businessId, name: "Sữa", unitOfMeasure: "Chai", isActive: true, hasLotTracking: false }];
  await assert.rejects(confirmSupplierImport(businessId, supplierId, file(), preview.mapping, preview.digest), error => error.statusCode === 409);
  assert.equal(writes.length, 0);
});
