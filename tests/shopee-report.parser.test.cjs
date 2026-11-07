const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
const ExcelJS = require("exceljs");
const { parseShopeeReport } = require("../src/modules/business-data/shopee-report.parser.ts");

async function sampleWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("Summary");
  summary.getCell("A10").value = "Từ";
  summary.getCell("B10").value = "2026-04-20";
  summary.getCell("A11").value = "Đến";
  summary.getCell("B11").value = "2026-04-23";

  const revenue = workbook.addWorksheet("Doanh thu");
  revenue.getCell("B3").value = "Đơn hàng / Sản phẩm";
  revenue.getCell("C3").value = "Mã đơn hàng";
  revenue.getCell("R3").value = "Người Mua";
  revenue.getCell("B4").value = "Order";
  revenue.getCell("C4").value = "ORDER-1";
  revenue.getCell("H4").value = "2026-04-20";
  revenue.getCell("I4").value = "2026-04-21";
  revenue.getCell("M4").value = 1_000;
  revenue.getCell("N4").value = 1_200;
  revenue.getCell("O4").value = -200;
  revenue.getCell("R4").value = "buyer-sensitive-data";
  revenue.getCell("B5").value = "Sku";
  revenue.getCell("C5").value = "ORDER-1";
  revenue.getCell("F5").value = "SKU-1";
  revenue.getCell("G5").value = "Product";
  revenue.getCell("H5").value = "2026-04-20";
  revenue.getCell("I5").value = "2026-04-21";
  revenue.getCell("N5").value = 1_200;
  revenue.getCell("R5").value = "buyer-sensitive-data";

  const adjustments = workbook.addWorksheet("Adjustment");
  adjustments.getCell("A17").value = "Mã giao dịch";
  adjustments.getCell("B17").value = "Ngày hoàn thành điều chỉnh";
  adjustments.getCell("C17").value = "Loại điều chỉnh";
  adjustments.getCell("E17").value = "Số tiền điều chỉnh";
  adjustments.getCell("F17").value = "Mã đơn hàng liên quan";
  adjustments.getCell("G17").value = "Ngày hoàn thành thanh toán";
  adjustments.getCell("A18").value = "TX-1";
  adjustments.getCell("B18").value = "2026-04-22";
  adjustments.getCell("C18").value = "Vận chuyển";
  adjustments.getCell("E18").value = -50;
  adjustments.getCell("F18").value = "ORDER-1";
  adjustments.getCell("G18").value = "2026-04-22";

  const fees = workbook.addWorksheet("Service Fee Details");
  fees.getCell("B2").value = "Mã đơn hàng";
  fees.getCell("C2").value = "Combo Gói Voucher Xtra";
  fees.getCell("B3").value = "ORDER-1";
  fees.getCell("C3").value = 10;

  const shipping = workbook.addWorksheet("Shipping Fee Discrepancy");
  shipping.getCell("A2").value = "Mã đơn hàng";
  shipping.getCell("B2").value = "Phí vận chuyển ước tính";
  shipping.getCell("C2").value = "Phí vận chuyển thực tế";
  shipping.getCell("D2").value = "Lý do chênh lệch";
  shipping.getCell("A3").value = "ORDER-1";
  shipping.getCell("B3").value = 20;
  shipping.getCell("C3").value = 25;
  shipping.getCell("D3").value = "reason text is not retained";

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("Shopee parser keeps order and SKU facts separate and never retains buyer columns", async () => {
  const parsed = await parseShopeeReport(await sampleWorkbook());
  const order = parsed.records.find((record) => record.recordType === "ORDER");
  const sku = parsed.records.find((record) => record.recordType === "SKU");

  assert.equal(parsed.reportFrom, "2026-04-20");
  assert.equal(parsed.reportTo, "2026-04-23");
  assert.equal(parsed.counts.ORDER, 1);
  assert.equal(parsed.counts.SKU, 1);
  assert.equal(order.financialData.productGrossAmount, 1_200);
  assert.equal(order.financialData.refundAmount, -200);
  assert.equal(sku.externalProductId, "SKU-1");
  assert.equal(sku.financialData, null);
  assert.equal(parsed.financeTotals.productGrossAmount, 1_200);
  assert.equal(parsed.financeTotals.refundAmount, -200);
  assert.equal(JSON.stringify(parsed).includes("buyer-sensitive-data"), false);
  assert.equal(JSON.stringify(parsed).includes("reason text is not retained"), false);
});

test("Shopee parser preserves adjustment sign and stores supplemental fees separately", async () => {
  const parsed = await parseShopeeReport(await sampleWorkbook());
  const adjustment = parsed.records.find((record) => record.recordType === "ADJUSTMENT");
  const fee = parsed.records.find((record) => record.recordType === "SERVICE_FEE");
  const shipping = parsed.records.find((record) => record.recordType === "SHIPPING_DISCREPANCY");

  assert.equal(adjustment.transactionDate, "2026-04-22");
  assert.equal(adjustment.financialData.adjustmentAmount, -50);
  assert.equal(fee.financialData.voucherPackageFee, 10);
  assert.equal(shipping.financialData.estimatedShippingFee, 20);
  assert.equal(shipping.financialData.actualShippingFee, 25);
});
