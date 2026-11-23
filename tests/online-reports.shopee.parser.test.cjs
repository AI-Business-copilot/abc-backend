const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");
const ExcelJS = require("exceljs");
const { parseShopeeReport } = require("../src/modules/online-reports/shopee/shopee-report.parser.ts");

async function sampleWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("Summary");
  summary.getCell("A10").value = "Từ";
  summary.getCell("B10").value = "2026-04-20";
  summary.getCell("A11").value = "Đến";
  summary.getCell("B11").value = "2026-04-23";
  summary.getCell("C10").value = "Tổng hàng hóa";
  summary.getCell("D10").value = 1_200;
  summary.getCell("C11").value = "Số tiền hoàn lại";
  summary.getCell("D11").value = -200;
  summary.getCell("C12").value = "Tổng doanh thu";
  summary.getCell("D12").value = 1_000;
  summary.getCell("C13").value = "Tổng chi phí";
  summary.getCell("D13").value = -40;
  summary.getCell("C14").value = "Tổng số tiền";
  summary.getCell("D14").value = 960;

  const revenue = workbook.addWorksheet("Doanh thu");
  revenue.getCell("A3").value = "Mã giao dịch";
  revenue.getCell("B3").value = "Đơn hàng / Sản phẩm";
  revenue.getCell("C3").value = "Mã đơn hàng";
  revenue.getCell("F3").value = "Mã sản phẩm";
  revenue.getCell("G3").value = "Tên sản phẩm";
  revenue.getCell("H3").value = "Thời gian đặt hàng";
  revenue.getCell("I3").value = "Thời gian thanh toán";
  revenue.getCell("M3").value = "Tổng tiền quyết toán cho người bán";
  revenue.getCell("N3").value = "Tổng tiền sản phẩm";
  revenue.getCell("O3").value = "Số tiền hoàn trả";
  revenue.getCell("R3").value = "Người Mua";
  revenue.getCell("A4").value = "TX-ORDER-1";
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
  assert.equal(parsed.summaryFinancialData.totalGoodsAmount, 1_200);
  assert.equal(parsed.summaryFinancialData.totalAmount, 960);
  assert.deepEqual(parsed.reconciliations.map(({ summaryField, matches }) => ({ summaryField, matches })), [
    { summaryField: "totalAmount", matches: false },
    { summaryField: "refundAmount", matches: true },
  ]);
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

test("Shopee income headers use official names from the report guide", async () => {
  const workbook = new ExcelJS.Workbook();
  const revenue = workbook.addWorksheet("Income");
  const headers = [
    "Đơn hàng / Sản phẩm",
    "Mã đơn hàng",
    "Tổng tiền đã thanh toán",
    "Giá sản phẩm",
    "Số tiền hoàn lại",
    "Sản phẩm được trợ giá từ Shopee",
    "Mã giảm giá",
    "Người bán hoàn xu",
    "Phí vận chuyển được trợ giá từ Shopee",
    "Phí xử lý giao dịch",
    "Thuế GTGT",
    "Thuế TNCN",
  ];
  headers.forEach((header, index) => revenue.getCell(3, index + 1).value = header);
  ["Order", "ORDER-GUIDE", 800, 1_000, -100, 25, -50, -10, 15, -20, -5, -3]
    .forEach((value, index) => revenue.getCell(4, index + 1).value = value);

  const parsed = await parseShopeeReport(Buffer.from(await workbook.xlsx.writeBuffer()));
  const order = parsed.records.find((record) => record.recordType === "ORDER");
  assert.equal(order.financialData.sellerReceivedAmount, 800);
  assert.equal(order.financialData.productPrice, 1_000);
  assert.equal(order.financialData.refundAmount, -100);
  assert.equal(order.financialData.platformProductSubsidy, 25);
  assert.equal(order.financialData.sellerVoucherDiscount, -50);
  assert.equal(order.financialData.sellerCoinDiscount, -10);
  assert.equal(order.financialData.platformShippingSubsidy, 15);
  assert.equal(order.financialData.transactionFee, -20);
  assert.equal(order.financialData.vat, -5);
  assert.equal(order.financialData.personalIncomeTax, -3);
});

test("Shopee income maps Product Price separately when both price columns exist", async () => {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("Summary");
  summary.getCell("A1").value = "Tổng hàng hóa";
  summary.getCell("B1").value = 1_250;
  const revenue = workbook.addWorksheet("Doanh thu");
  [
    ["Đơn hàng / Sản phẩm", "Mã đơn hàng", "Tổng tiền sản phẩm", "Giá sản phẩm"],
    ["Order", "ORDER-DUAL-PRICE", 1_250, 1_200],
  ].forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    revenue.getCell(rowIndex + 1, columnIndex + 1).value = value;
  }));

  const parsed = await parseShopeeReport(Buffer.from(await workbook.xlsx.writeBuffer()));
  const order = parsed.records.find((record) => record.recordType === "ORDER");
  assert.equal(order.financialData.productGrossAmount, 1_250);
  assert.equal(order.financialData.productPrice, 1_200);
  assert.deepEqual(parsed.reconciliations, []);
});

test("Shopee sample-style merged headers distinguish order classification and ignore identifiers", async () => {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("Summary");
  summary.getCell("A1").value = "1. Tổng doanh thu";
  summary.getCell("D1").value = 100;
  summary.getCell("A2").value = "3. Tổng số tiền";
  summary.getCell("D2").value = 80;
  const revenue = workbook.addWorksheet("Doanh thu");
  revenue.mergeCells("D2:E2");
  revenue.getCell("D2").value = "Tổng tiền sản phẩm";
  [
    ["Đơn hàng / Sản phẩm", "Mã đơn hàng", "Loại đơn hàng", "Giá sản phẩm", "Số tiền hoàn lại", "Ngày hoàn thành thanh toán", "Mã số thuế", "Transaction Fee Rate (%)", "Tổng tiền đã thanh toán"],
    ["Order", "ORDER-1", "Đơn thường", 100, -20, "2026-04-23", 123456789, 0.05, 80],
  ].forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    revenue.getCell(rowIndex + 3, columnIndex + 1).value = value;
  }));
  const fees = workbook.addWorksheet("Service Fee Details");
  [["Mã giao dịch", "Mã đơn hàng", "Gói Live Xtra", "Gói Ưu Đãi Phí Vận Chuyển Xtra"],
    ["123456789", "ORDER-1", -2, -3]]
    .forEach((row, i) => row.forEach((value, j) => { fees.getCell(i + 2, j + 1).value = value; }));
  const parsed = await parseShopeeReport(Buffer.from(await workbook.xlsx.writeBuffer()));
  const order = parsed.records.find((record) => record.recordType === "ORDER");
  const fee = parsed.records.find((record) => record.recordType === "SERVICE_FEE");
  assert.equal(order.settlementDate, "2026-04-23");
  assert.equal(order.financialData.productPrice, 100);
  assert.equal(order.financialData.refundAmount, -20);
  assert.equal(order.unmappedFinancialData, null);
  assert.equal(fee.financialData.livePackageFee, -2);
  assert.equal(fee.financialData.shippingPromotionPackageFee, -3);
  assert.equal(fee.unmappedFinancialData, null);
  assert.equal(parsed.summaryFinancialData.totalRevenue, 100);
  assert.equal(parsed.summaryFinancialData.totalAmount, 80);
  assert.equal(parsed.reconciliations.find((check) => check.summaryField === "totalAmount").matches, true);
  assert.equal(JSON.stringify(parsed).includes("123456789"), false);
});

test("Shopee ignores duplicate aliases in rows that are not headers", async () => {
  const workbook = new ExcelJS.Workbook();
  const revenue = workbook.addWorksheet("Doanh thu");
  revenue.getCell("A1").value = "Mã đơn hàng";
  revenue.getCell("B1").value = "Mã đơn";
  revenue.getCell("A3").value = "Đơn hàng / Sản phẩm";
  revenue.getCell("B3").value = "Mã đơn hàng";
  revenue.getCell("C3").value = "Giá sản phẩm";
  revenue.getCell("A4").value = "Order";
  revenue.getCell("B4").value = "ORDER-1";
  revenue.getCell("C4").value = 100;
  const parsed = await parseShopeeReport(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(parsed.counts.ORDER, 1);
});

test("Shopee duplicate order rows do not inflate preview totals", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Doanh thu");
  [
    ["Đơn hàng / Sản phẩm", "Mã đơn hàng", "Giá sản phẩm"],
    ["Order", "ORDER-1", 100],
    ["Order", "ORDER-1", 100],
  ].forEach((row, i) => row.forEach((value, j) => { sheet.getCell(i + 1, j + 1).value = value; }));
  const parsed = await parseShopeeReport(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(parsed.sourceRowCount, 2);
  assert.equal(parsed.counts.ORDER, 1);
  assert.equal(parsed.financeTotals.productPrice, 100);
});

test("Shopee income quarantines duplicate aliases instead of rejecting the whole report", async () => {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("Summary");
  summary.getCell("A1").value = "Tổng hàng hóa";
  summary.getCell("B1").value = 1_250;
  const revenue = workbook.addWorksheet("Doanh thu");
  [
    ["Đơn hàng / Sản phẩm", "Mã đơn hàng", "Tổng tiền sản phẩm", "Tổng giá trị sản phẩm"],
    ["Order", "ORDER-DUPLICATE-GROSS", 1_250, 1_200],
  ].forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    revenue.getCell(rowIndex + 1, columnIndex + 1).value = value;
  }));

  const parsed = await parseShopeeReport(Buffer.from(await workbook.xlsx.writeBuffer()));
  const order = parsed.records.find((record) => record.recordType === "ORDER");
  assert.equal(order.financialData, null);
  assert.equal(parsed.financeTotals.productGrossAmount, undefined);
  assert.deepEqual(Object.values(order.unmappedFinancialData).sort((a, b) => a - b), [1_200, 1_250]);
  assert.equal(parsed.unmappedFieldSummaries.length, 2);
  assert.equal(parsed.reconciliations.length, 0);
});

test("Shopee parser maps columns by headers when rows and columns move and preserves new financial fields", async () => {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("Summary");
  summary.getCell("C12").value = "Ngày bắt đầu";
  summary.getCell("D12").value = "21/04/2026";
  summary.getCell("C13").value = "Ngày kết thúc";
  summary.getCell("D13").value = "23/04/2026";

  const revenue = workbook.addWorksheet("Báo cáo giao dịch");
  revenue.getCell("D6").value = "Đơn hàng / Sản phẩm";
  revenue.getCell("E6").value = "Mã đơn hàng";
  revenue.getCell("G6").value = "Mã sản phẩm";
  revenue.getCell("H6").value = "Tên sản phẩm";
  revenue.getCell("I6").value = "Ngày đặt hàng";
  revenue.getCell("J6").value = "Ngày thanh toán";
  revenue.getCell("P6").value = "Phí nền tảng mới";
  revenue.getCell("Q6").value = "Số tiền người bán nhận được";
  revenue.getCell("R6").value = "Tổng tiền sản phẩm";
  revenue.getCell("S6").value = "Số tiền hoàn trả";
  revenue.getCell("T6").value = "Người mua";
  revenue.getCell("D7").value = "Order";
  revenue.getCell("E7").value = "ORDER-MOVED";
  revenue.getCell("I7").value = "2026-04-21";
  revenue.getCell("J7").value = "2026-04-22";
  revenue.getCell("P7").value = -15;
  revenue.getCell("Q7").value = "1.234,50";
  revenue.getCell("R7").value = 1_500;
  revenue.getCell("S7").value = -250;
  revenue.getCell("T7").value = "sensitive buyer value";

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parseShopeeReport(buffer);
  const order = parsed.records.find((record) => record.recordType === "ORDER");
  assert.equal(parsed.reportFrom, "2026-04-21");
  assert.equal(parsed.reportTo, "2026-04-23");
  assert.equal(order.transactionDate, "2026-04-21");
  assert.equal(order.financialData.sellerReceivedAmount, 1234.5);
  assert.equal(order.financialData.productGrossAmount, 1500);
  assert.equal(order.financialData.refundAmount, -250);
  assert.equal(order.financialData["Phí nền tảng mới"], undefined);
  assert.equal(order.unmappedFinancialData["Phí nền tảng mới"], -15);
  assert.equal(JSON.stringify(parsed).includes("sensitive buyer value"), false);
  assert.equal(parsed.financeTotals["Phí nền tảng mới"], undefined);
  assert.deepEqual(parsed.unmappedFieldSummaries, [
    { sourceSheet: "Báo cáo giao dịch", header: "Phí nền tảng mới", occurrences: 1 },
  ]);
});

test("Shopee supplemental sheets also tolerate shifted header rows and columns", async () => {
  const workbook = new ExcelJS.Workbook();
  const revenue = workbook.addWorksheet("Doanh thu");
  revenue.getCell("B5").value = "Đơn hàng / Sản phẩm";
  revenue.getCell("C5").value = "Mã đơn hàng";
  revenue.getCell("M5").value = "Tổng tiền sản phẩm";
  revenue.getCell("B6").value = "Order";
  revenue.getCell("C6").value = "ORDER-1";
  revenue.getCell("M6").value = 100;

  const adjustments = workbook.addWorksheet("Điều chỉnh");
  adjustments.getCell("D8").value = "Mã giao dịch";
  adjustments.getCell("E8").value = "Ngày hoàn thành điều chỉnh";
  adjustments.getCell("F8").value = "Loại điều chỉnh";
  adjustments.getCell("H8").value = "Số tiền điều chỉnh";
  adjustments.getCell("I8").value = "Phí xử lý mới";
  adjustments.getCell("J8").value = "Mã đơn hàng liên quan";
  adjustments.getCell("D9").value = "TX-1";
  adjustments.getCell("E9").value = "22/04/2026";
  adjustments.getCell("F9").value = "Vận chuyển";
  adjustments.getCell("H9").value = -50;
  adjustments.getCell("I9").value = -5;
  adjustments.getCell("J9").value = "ORDER-1";

  const fees = workbook.addWorksheet("Chi tiết phí dịch vụ");
  fees.getCell("C4").value = "Mã đơn hàng";
  fees.getCell("F4").value = "Gói Voucher Xtra";
  fees.getCell("G4").value = "Phí dịch vụ mở rộng";
  fees.getCell("C5").value = "ORDER-1";
  fees.getCell("F5").value = 10;
  fees.getCell("G5").value = 3;

  const shipping = workbook.addWorksheet("Chênh lệch phí vận chuyển");
  shipping.getCell("D7").value = "Mã đơn hàng";
  shipping.getCell("F7").value = "Phí vận chuyển ước tính";
  shipping.getCell("H7").value = "Phí vận chuyển thực tế";
  shipping.getCell("D8").value = "ORDER-1";
  shipping.getCell("F8").value = 20;
  shipping.getCell("H8").value = 25;

  const parsed = await parseShopeeReport(Buffer.from(await workbook.xlsx.writeBuffer()));
  const adjustment = parsed.records.find((record) => record.recordType === "ADJUSTMENT");
  const fee = parsed.records.find((record) => record.recordType === "SERVICE_FEE");
  const shippingRecord = parsed.records.find((record) => record.recordType === "SHIPPING_DISCREPANCY");
  assert.equal(adjustment.transactionDate, "2026-04-22");
  assert.equal(adjustment.financialData.adjustmentAmount, -50);
  assert.equal(adjustment.financialData["Phí xử lý mới"], undefined);
  assert.equal(adjustment.unmappedFinancialData["Phí xử lý mới"], -5);
  assert.equal(fee.financialData.voucherPackageFee, 10);
  assert.equal(fee.financialData["Phí dịch vụ mở rộng"], undefined);
  assert.equal(fee.unmappedFinancialData["Phí dịch vụ mở rộng"], 3);
  assert.equal(shippingRecord.financialData.estimatedShippingFee, 20);
  assert.equal(shippingRecord.financialData.actualShippingFee, 25);
});

test("Shopee parser rejects an unrecognized header layout instead of assigning amounts by position", async () => {
  const workbook = new ExcelJS.Workbook();
  const revenue = workbook.addWorksheet("Doanh thu");
  revenue.getCell("B3").value = "Loại dữ liệu";
  revenue.getCell("C3").value = "Mã đơn";
  revenue.getCell("M3").value = "Ghi chú";
  revenue.getCell("B4").value = "Order";
  revenue.getCell("C4").value = "ORDER-1";
  revenue.getCell("M4").value = 500;

  await assert.rejects(
    parseShopeeReport(Buffer.from(await workbook.xlsx.writeBuffer())),
    /No supported financial columns/,
  );
});
