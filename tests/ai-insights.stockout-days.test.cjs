require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");

const { computeStockoutDays, verifiedStockoutDays, uncensoredAverage } = require("../src/modules/ai-insights/snapshot/build-snapshot.ts");

test("computeStockoutDays rebuilds closing stock from the ledger", () => {
  const changes = [10, -10, 0, 20, -15, 0];
  // closing: today(idx5)=5, idx4=5, idx3=20, idx2=0, idx1=0, idx0=10
  assert.deepEqual(computeStockoutDays(5, changes), [false, true, true, false, false, false]);
});

test("forecast history is unknown without a reconciled ledger", () => {
  const changes = [10, -5, 0];
  const sales = [0, 5];
  assert.deepEqual(verifiedStockoutDays(5, changes, [0, 5, 0], sales, 0, 0, 0), [null, null, null]);
  assert.deepEqual(verifiedStockoutDays(6, changes, [0, 5, 0], sales, 5, 2, 0), [null, null, null]);
});

test("forecast history stops at missing sales and at the first ledger entry", () => {
  const changes = [10, -5, 0, 0];
  assert.deepEqual(verifiedStockoutDays(5, changes, [0, 5, 0, 0], [0, 5, 0], 5, 2, 0), [false, false, false, false]);
  assert.deepEqual(verifiedStockoutDays(5, changes, [0, 4, 0, 0], [0, 5, 0], 5, 2, 0), [null, null, false, false]);
  assert.deepEqual(verifiedStockoutDays(5, changes, [0, 5, 0, 0], [0, 5, 0], 5, 2, 2), [null, null, false, false]);
});

test("negative reconstructed stock makes that day and earlier days unknown", () => {
  assert.deepEqual(verifiedStockoutDays(1, [5, -6, 5, -3], [0, 0, 0, 0], [0, 0, 0], 1, 3, 0), [null, null, false, false]);
});

test("uncensoredAverage ignores stockout days", () => {
  const sales = new Array(30).fill(2);
  const flags = new Array(30).fill(false);
  for (let i = 0; i < 10; i++) {
    sales[i] = 0;
    flags[i] = true;
  }
  assert.equal(uncensoredAverage(sales, flags, 30, 365), 2);
});

test("uncensoredAverage falls back to the raw mean when almost every day was a stockout", () => {
  const sales = new Array(30).fill(0);
  sales[29] = 30;
  const flags = new Array(30).fill(true);
  assert.equal(uncensoredAverage(sales, flags, 30, 365), 1);
});

test("uncensoredAverage divides by product age for new products", () => {
  const sales = new Array(30).fill(0);
  for (let i = 25; i < 30; i++) sales[i] = 4;
  assert.equal(uncensoredAverage(sales, new Array(30).fill(false), 30, 5), 4);
});
