import { createHash } from "node:crypto";
import ExcelJS from "exceljs";

import { HttpError } from "../../shared/http/http-error";

export type ShopeeRecordType = "ORDER" | "SKU" | "ADJUSTMENT" | "SERVICE_FEE" | "SHIPPING_DISCREPANCY";
export const SHOPEE_MAPPING_VERSION = 5;

export interface ParsedShopeeRecord {
  recordType: ShopeeRecordType;
  sourceKey: string;
  sourceSheet: string;
  sourceRow: number;
  externalOrderId: string | null;
  externalProductId: string | null;
  productName: string | null;
  transactionDate: string | null;
  settlementDate: string | null;
  financialData: Record<string, number | string> | null;
  unmappedFinancialData: Record<string, number> | null;
}

export interface UnmappedFieldSummary {
  sourceSheet: string;
  header: string;
  occurrences: number;
}

export interface ShopeeReconciliationCheck {
  summaryField: string;
  incomeField: string;
  summaryAmount: number;
  incomeAmount: number;
  difference: number;
  matches: boolean;
}

export interface ParsedShopeeReport {
  mappingVersion: number;
  fileHash: string;
  reportFrom: string | null;
  reportTo: string | null;
  sourceRowCount: number;
  records: ParsedShopeeRecord[];
  counts: Record<ShopeeRecordType, number>;
  financeTotals: Record<string, number>;
  summaryFinancialData: Record<string, number>;
  reconciliations: ShopeeReconciliationCheck[];
  unmappedFieldSummaries: UnmappedFieldSummary[];
}

interface HeaderDefinition {
  key: string;
  aliases: string[];
  financial?: boolean;
}

interface HeaderMapping {
  rowNumber: number;
  columns: Map<string, number>;
  definitions: Map<string, HeaderDefinition>;
  unknownFinancialColumns: Array<{ column: number; label: string }>;
}

const REVENUE_HEADERS: HeaderDefinition[] = [
  { key: "transactionId", aliases: ["Mã giao dịch", "Transaction ID", "Transaction Number"] },
  { key: "recordType", aliases: ["Đơn hàng / Sản phẩm", "Loại giao dịch", "Loại dữ liệu", "Order / Product", "Record Type", "Transaction Type"] },
  { key: "orderType", aliases: ["Loại đơn hàng", "Order Type"] },
  { key: "taxId", aliases: ["Mã số thuế", "Tax ID"] },
  { key: "refundRequestId", aliases: ["Mã yêu cầu hoàn tiền", "Refund Request ID"] },
  { key: "paymentMethod", aliases: ["Phương thức thanh toán", "Payment Method"] },
  { key: "bestSeller", aliases: ["Sản phẩm bán chạy"] },
  { key: "transactionFeeRate", aliases: ["Transaction Fee Rate (%)", "Tỷ lệ phí giao dịch"] },
  { key: "orderId", aliases: ["Mã đơn hàng", "Mã đơn hàng liên quan", "Mã đơn", "Order ID", "Order Number", "Order SN"] },
  { key: "productId", aliases: ["Mã sản phẩm", "Mã SKU", "SKU sản phẩm", "Product ID", "SKU"] },
  { key: "productName", aliases: ["Tên sản phẩm", "Product Name", "Product Title"] },
  { key: "transactionDate", aliases: ["Thời gian đặt hàng", "Ngày đặt hàng", "Ngày giao dịch", "Transaction Date", "Order Date"] },
  { key: "settlementDate", aliases: ["Ngày hoàn thành thanh toán", "Thời gian thanh toán", "Ngày thanh toán", "Ngày quyết toán", "Settlement Date", "Payout Date"] },
  { key: "sellerReceivedAmount", financial: true, aliases: [
    "sellerReceivedAmount", "Tổng tiền quyết toán cho người bán", "Tổng tiền người bán nhận được",
    "Số tiền người bán nhận được", "Tổng tiền đã thanh toán",
  ] },
  { key: "productGrossAmount", financial: true, aliases: [
    "productGrossAmount", "Tổng tiền sản phẩm", "Tổng giá trị sản phẩm", "Product Gross Amount",
  ] },
  { key: "productPrice", financial: true, aliases: [
    "productPrice", "Giá sản phẩm", "Product Price",
  ] },
  { key: "refundAmount", financial: true, aliases: [
    "refundAmount", "Số tiền hoàn trả", "Số tiền hoàn lại", "Refund Amount",
  ] },
  { key: "buyerShippingPaid", financial: true, aliases: [
    "buyerShippingPaid", "Phí vận chuyển người mua trả", "Phí vận chuyển do người mua thanh toán",
    "Phí vận chuyển khách hàng thanh toán", "Buyer Shipping Paid",
  ] },
  { key: "actualShippingFee", financial: true, aliases: [
    "actualShippingFee", "Phí vận chuyển thực tế", "Cước vận chuyển thực tế", "Actual Shipping Fee",
  ] },
  { key: "platformShippingSubsidy", financial: true, aliases: [
    "platformShippingSubsidy", "Trợ giá vận chuyển từ Shopee", "Shopee trợ giá vận chuyển",
    "Phí vận chuyển được trợ giá từ Shopee", "Trợ giá vận chuyển", "Platform Shipping Subsidy",
  ] },
  { key: "returnShippingFee", financial: true, aliases: [
    "returnShippingFee", "Phí vận chuyển trả hàng", "Phí vận chuyển hoàn hàng", "Phí vận chuyển trả hàng (đơn Trả hàng/hoàn tiền)", "Return Shipping Fee",
  ] },
  { key: "pishipShippingRefund", financial: true, aliases: [
    "pishipShippingRefund", "Phí vận chuyển PiShip được hoàn", "Phí vận chuyển được hoàn bởi PiShip", "PiShip Shipping Refund",
  ] },
  { key: "failedDeliveryReturnShippingFee", financial: true, aliases: [
    "failedDeliveryReturnShippingFee", "Phí vận chuyển hoàn hàng giao không thành công",
    "Phí vận chuyển đơn giao không thành công", "Phí vận chuyển trả hàng (đơn giao không thành công)", "Failed Delivery Return Shipping Fee",
  ] },
  { key: "platformProductSubsidy", financial: true, aliases: [
    "platformProductSubsidy", "Sản phẩm được trợ giá từ Shopee", "Trợ giá sản phẩm từ Shopee", "Shopee trợ giá sản phẩm",
    "Trợ giá sản phẩm", "Platform Product Subsidy",
  ] },
  { key: "sellerVoucherDiscount", financial: true, aliases: [
    "sellerVoucherDiscount", "Voucher do người bán chịu", "Mã giảm giá của người bán",
    "Mã ưu đãi do người bán chịu", "Mã giảm giá", "Seller Voucher Discount",
  ] },
  { key: "sellerCoFundedVoucherDiscount", financial: true, aliases: [
    "sellerCoFundedVoucherDiscount", "Voucher đồng tài trợ do người bán chịu",
    "Mã giảm giá đồng tài trợ của người bán", "Mã ưu đãi Đồng Tài Trợ do Người Bán chịu", "Seller Co-funded Voucher Discount",
  ] },
  { key: "sellerCoinDiscount", financial: true, aliases: [
    "sellerCoinDiscount", "Người bán hoàn xu", "Xu do người bán chịu", "Mã hoàn xu do người bán chịu", "Seller Coin Discount",
  ] },
  { key: "sellerCoFundedCoinDiscount", financial: true, aliases: [
    "sellerCoFundedCoinDiscount", "Xu đồng tài trợ do người bán chịu",
    "Mã hoàn xu đồng tài trợ do người bán chịu", "Seller Co-funded Coin Discount",
  ] },
  { key: "fixedPlatformFee", financial: true, aliases: [
    "fixedPlatformFee", "Phí cố định", "Phí cố định của Shopee", "Phí cố định của sàn", "Fixed Platform Fee",
  ] },
  { key: "serviceFee", financial: true, aliases: [
    "serviceFee", "Phí dịch vụ", "Phí dịch vụ Shopee", "Service Fee",
  ] },
  { key: "transactionFee", financial: true, aliases: [
    "transactionFee", "Phí xử lý giao dịch", "Phí thanh toán", "Phí giao dịch", "Transaction Fee",
  ] },
  { key: "affiliateFee", financial: true, aliases: [
    "affiliateFee", "Phí tiếp thị liên kết", "Phí hoa hồng tiếp thị liên kết", "Affiliate Fee",
  ] },
  { key: "pishipServiceFee", financial: true, aliases: [
    "pishipServiceFee", "Phí dịch vụ PiShip", "PiShip Service Fee",
  ] },
  { key: "automaticTopUp", financial: true, aliases: [
    "automaticTopUp", "Nạp tiền tự động", "Khoản nạp tự động từ doanh thu", "Mức Nạp Tiền Tự Động (từ doanh thu đơn hàng)", "Automatic Top-up",
  ] },
  { key: "vat", financial: true, aliases: ["vat", "Thuế GTGT", "Thuế VAT", "Thuế giá trị gia tăng", "Value Added Tax"] },
  { key: "personalIncomeTax", financial: true, aliases: [
    "personalIncomeTax", "Thuế TNCN", "Thuế thu nhập cá nhân", "Personal Income Tax",
  ] },
  { key: "buyerInstallationFee", financial: true, aliases: [
    "buyerInstallationFee", "Phí lắp đặt người mua trả", "Phí lắp đặt khách hàng thanh toán",
    "Buyer Installation Fee",
  ] },
  { key: "actualInstallationFee", financial: true, aliases: [
    "actualInstallationFee", "Phí lắp đặt thực tế", "Actual Installation Fee",
  ] },
  { key: "sellerTradeInBonus", financial: true, aliases: [
    "sellerTradeInBonus", "Thưởng đổi cũ do người bán tài trợ", "Trade-in Bonus by Seller", "Seller Trade-in Bonus",
  ] },
  { key: "sellerShippingSupport", financial: true, aliases: [
    "sellerShippingSupport", "Phí vận chuyển người bán hỗ trợ", "Người bán hỗ trợ phí vận chuyển",
    "Seller Shipping Support",
  ] },
  { key: "lostParcelCompensation", financial: true, aliases: [
    "lostParcelCompensation", "Tiền bồi thường thất lạc hàng", "Bồi thường thất lạc hàng", "Đền bù mất hàng",
    "Lost Parcel Compensation",
  ] },
  { key: "productPaidAfterPromotion", financial: true, aliases: [
    "productPaidAfterPromotion", "Giá sản phẩm sau khuyến mãi", "Giá sản phẩm (sau khuyến mãi)", "Tiền sản phẩm sau khuyến mãi",
    "Product Paid After Promotion",
  ] },
  { key: "shopeeCoinDiscount", financial: true, aliases: [
    "shopeeCoinDiscount", "Shopee xu", "Giảm giá bằng Shopee Xu", "Shopee Coin Discount",
  ] },
  { key: "shopeeVoucherDiscount", financial: true, aliases: [
    "shopeeVoucherDiscount", "Shopee voucher", "Ưu đãi do Shopee tài trợ", "Voucher do Shopee tài trợ",
    "Shopee Voucher Discount",
  ] },
  { key: "bankPromotionDiscount", financial: true, aliases: [
    "bankPromotionDiscount", "Ngân hàng khuyến mãi thanh toán trên Thẻ Tín Dụng", "Ưu đãi ngân hàng", "Khuyến mãi ngân hàng", "Bank Promotion Discount",
  ] },
  { key: "shopeeBankPromotionDiscount", financial: true, aliases: [
    "shopeeBankPromotionDiscount", "Shopee khuyến mãi thanh toán trên Thẻ Tín Dụng", "Ưu đãi thanh toán thẻ do Shopee tài trợ",
    "Khuyến mãi ngân hàng do Shopee tài trợ", "Shopee Bank Promotion Discount",
  ] },
];

const SUMMARY_FINANCE_HEADERS: HeaderDefinition[] = [
  { key: "totalGoodsAmount", aliases: ["Tổng hàng hóa", "Total Goods"] },
  { key: "originalPrice", aliases: ["Giá gốc", "Original Price"] },
  { key: "sellerProductSubsidy", aliases: ["Số tiền bạn trợ giá cho sản phẩm", "Seller Product Subsidy"] },
  { key: "refundAmount", aliases: ["Số tiền hoàn lại", "Refund Amount"] },
  { key: "platformProductSubsidy", aliases: ["Sản phẩm được trợ giá từ Shopee", "Shopee Product Subsidy"] },
  { key: "sellerVoucherDiscount", aliases: ["Mã giảm giá", "Mã ưu đãi do Người Bán chịu", "Seller Voucher Discount"] },
  { key: "sellerCoFundedVoucherDiscount", aliases: ["Mã ưu đãi Đồng Tài Trợ do Người Bán chịu"] },
  { key: "sellerCoinDiscount", aliases: ["Người bán hoàn xu", "Mã hoàn xu do Người Bán chịu", "Seller Coin Discount"] },
  { key: "sellerCoFundedCoinDiscount", aliases: ["Mã hoàn xu Đồng Tài Trợ do Người Bán chịu"] },
  { key: "buyerShippingPaid", aliases: ["Phí vận chuyển người mua trả", "Phí vận chuyển người mua thanh toán", "Buyer Shipping Paid"] },
  { key: "platformShippingSubsidy", aliases: ["Phí vận chuyển được trợ giá từ Shopee", "Shopee Shipping Subsidy"] },
  { key: "actualShippingFee", aliases: ["Phí vận chuyển thực tế", "Actual Shipping Fee"] },
  { key: "returnShippingFee", aliases: ["Phí vận chuyển trả hàng (đơn Trả hàng/hoàn tiền)"] },
  { key: "pishipShippingRefund", aliases: ["Phí vận chuyển được hoàn bởi PiShip"] },
  { key: "failedDeliveryReturnShippingFee", aliases: ["Phí vận chuyển trả hàng (đơn giao không thành công)"] },
  { key: "totalShipping", aliases: ["Tổng vận chuyển", "Total Shipping"] },
  { key: "affiliateFee", aliases: ["Phí hoa hồng tiếp thị liên kết", "Affiliate Fee"] },
  { key: "fixedPlatformFee", aliases: ["Phí cố định", "Fixed Platform Fee"] },
  { key: "serviceFee", aliases: ["Phí dịch vụ", "Service Fee"] },
  { key: "pishipServiceFee", aliases: ["Phí dịch vụ PiShip"] },
  { key: "automaticTopUp", aliases: ["Mức Nạp Tiền Tự Động (từ doanh thu đơn hàng)"] },
  { key: "transactionFee", aliases: ["Phí xử lý giao dịch", "Phí giao dịch", "Transaction Fee"] },
  { key: "vat", aliases: ["Thuế GTGT", "Thuế giá trị gia tăng", "VAT"] },
  { key: "personalIncomeTax", aliases: ["Thuế TNCN", "Thuế thu nhập cá nhân", "Personal Income Tax"] },
  { key: "totalSurcharge", aliases: ["Phụ phí", "Surcharge"] },
  { key: "totalRevenue", aliases: ["Tổng doanh thu", "Total Revenue"] },
  { key: "totalExpenses", aliases: ["Tổng chi phí", "Total Expenses"] },
  { key: "totalAmount", aliases: ["Tổng số tiền", "Tổng tiền", "Total Amount"] },
];

const SUMMARY_INCOME_RECONCILIATION_FIELDS = [
  { summaryField: "totalAmount", incomeFields: ["sellerReceivedAmount"] },
  { summaryField: "refundAmount", incomeFields: ["refundAmount"] },
  { summaryField: "platformProductSubsidy", incomeFields: ["platformProductSubsidy"] },
  { summaryField: "sellerVoucherDiscount", incomeFields: ["sellerVoucherDiscount"] },
  { summaryField: "sellerCoFundedVoucherDiscount", incomeFields: ["sellerCoFundedVoucherDiscount"] },
  { summaryField: "sellerCoinDiscount", incomeFields: ["sellerCoinDiscount"] },
  { summaryField: "sellerCoFundedCoinDiscount", incomeFields: ["sellerCoFundedCoinDiscount"] },
  { summaryField: "buyerShippingPaid", incomeFields: ["buyerShippingPaid"] },
  { summaryField: "platformShippingSubsidy", incomeFields: ["platformShippingSubsidy"] },
  { summaryField: "actualShippingFee", incomeFields: ["actualShippingFee"] },
  { summaryField: "returnShippingFee", incomeFields: ["returnShippingFee"] },
  { summaryField: "pishipShippingRefund", incomeFields: ["pishipShippingRefund"] },
  { summaryField: "failedDeliveryReturnShippingFee", incomeFields: ["failedDeliveryReturnShippingFee"] },
  { summaryField: "affiliateFee", incomeFields: ["affiliateFee"] },
  { summaryField: "fixedPlatformFee", incomeFields: ["fixedPlatformFee"] },
  { summaryField: "serviceFee", incomeFields: ["serviceFee"] },
  { summaryField: "pishipServiceFee", incomeFields: ["pishipServiceFee"] },
  { summaryField: "automaticTopUp", incomeFields: ["automaticTopUp"] },
  { summaryField: "transactionFee", incomeFields: ["transactionFee"] },
  { summaryField: "vat", incomeFields: ["vat"] },
  { summaryField: "personalIncomeTax", incomeFields: ["personalIncomeTax"] },
] as const;

const ADJUSTMENT_HEADERS: HeaderDefinition[] = [
  { key: "transactionId", aliases: ["Mã giao dịch", "Transaction ID"] },
  { key: "transactionDate", aliases: ["Ngày hoàn thành điều chỉnh", "Thời gian hoàn thành điều chỉnh", "Ngày điều chỉnh", "Adjustment Date"] },
  { key: "adjustmentType", aliases: ["Loại điều chỉnh", "Adjustment Type"] },
  { key: "adjustmentAmount", financial: true, aliases: ["Số tiền điều chỉnh", "Adjustment Amount", "Amount"] },
  { key: "orderId", aliases: ["Mã đơn hàng liên quan", "Mã đơn hàng", "Related Order ID", "Order ID"] },
  { key: "settlementDate", aliases: ["Ngày hoàn thành thanh toán", "Ngày thanh toán", "Settlement Date"] },
];

const SERVICE_FEE_HEADERS: HeaderDefinition[] = [
  { key: "transactionId", aliases: ["Mã giao dịch", "Transaction ID"] },
  { key: "orderId", aliases: ["Mã đơn hàng", "Order ID", "Order Number"] },
  { key: "voucherPackageFee", financial: true, aliases: ["Combo Gói Voucher Xtra", "Gói Voucher Xtra", "Phí gói Voucher Xtra", "Voucher Package Fee"] },
  { key: "livePackageFee", financial: true, aliases: ["Gói Live Xtra", "Combo Gói Livestream", "Gói Livestream", "Phí gói Livestream", "Live Package Fee"] },
  { key: "experiencePackageFee", financial: true, aliases: ["Combo Gói Trải nghiệm", "Gói Trải nghiệm", "Phí gói Trải nghiệm", "Experience Package Fee"] },
  { key: "shippingPromotionPackageFee", financial: true, aliases: ["Gói Ưu Đãi Phí Vận Chuyển Xtra", "Combo Gói Freeship Xtra", "Gói Freeship Xtra", "Phí gói ưu đãi vận chuyển", "Shipping Promotion Package Fee"] },
];

const SHIPPING_HEADERS: HeaderDefinition[] = [
  { key: "orderId", aliases: ["Mã đơn hàng", "Order ID", "Order Number"] },
  { key: "estimatedShippingFee", financial: true, aliases: ["Phí vận chuyển ước tính", "Cước vận chuyển ước tính", "Estimated Shipping Fee"] },
  { key: "actualShippingFee", financial: true, aliases: ["Phí vận chuyển thực tế", "Cước vận chuyển thực tế", "Actual Shipping Fee"] },
];

const SENSITIVE_HEADER_TERMS = [
  "buyer", "customer",
  "buyername", "buyerid", "buyerphone", "buyeremail", "buyeraddress", "nguoimua",
  "customername", "customerid", "customerphone", "customeremail", "customeraddress",
  "manguoimua", "tennguoimua", "sdtnguoimua", "emailnguoimua", "diachinguoimua",
  "tenkhach", "makhach", "sdtkhach", "emailkhach", "diachikhach",
  "phone", "mobile", "email", "address", "diachi", "sdt", "hoten", "fullname",
  "reason", "lydo", "note", "ghichu", "bankaccount", "accountnumber", "paymentidentity", "masothue", "taxid",
];
const MAX_HEADER_SCAN_ROWS = 50;

function valueAt(row: ExcelJS.Row, column: number): unknown {
  const value = row.getCell(column).value;
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    if ("result" in value) return value.result;
    if ("text" in value) return value.text;
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => item.text).join("");
    }
  }
  return value;
}

function textAt(row: ExcelJS.Row, column: number): string | null {
  const value = valueAt(row, column);
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return !text || text === "-" ? null : text;
}

function normalizeLabel(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, (letter) => letter === "Đ" ? "D" : "d")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]/g, "");
}

function normalizeHeader(value: unknown): string {
  return normalizeLabel(value).replace(/vnd$/, "");
}

function dateAt(row: ExcelJS.Row, column: number): string | null {
  const value = valueAt(row, column);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  if (iso) {
    const [, year, month, day] = iso;
    return validDate(Number(year), Number(month), Number(day));
  }
  const vietnamese = text.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/);
  if (!vietnamese) return null;
  return validDate(Number(vietnamese[3]), Number(vietnamese[2]), Number(vietnamese[1]));
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function amountAt(row: ExcelJS.Row, column: number): number | null {
  const value = valueAt(row, column);
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/[₫đ\s]/gi, "").replace(/[−–]/g, "-");
  if (!text || text === "-") return null;
  const parenthesized = text.startsWith("(") && text.endsWith(")");
  text = text.replace(/[()']/g, "");
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    text = text.replace(thousands, "").replace(decimal, ".");
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const parts = text.split(separator);
    if (parts.length > 2) {
      const last = parts.pop() ?? "";
      text = parts.join("") + (last.length === 3 ? last : `.${last}`);
    } else {
      const [whole = "", fraction = ""] = parts;
      text = fraction.length === 3 ? `${whole}${fraction}` : `${whole}.${fraction}`;
    }
  }
  if (parenthesized && !text.startsWith("-")) text = `-${text}`;
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}

function aliasMap(definitions: HeaderDefinition[]): Map<string, HeaderDefinition> {
  const aliases = new Map<string, HeaderDefinition>();
  for (const definition of definitions) {
    for (const alias of [definition.key, ...definition.aliases]) {
      const normalized = normalizeHeader(alias);
      const existing = aliases.get(normalized);
      if (existing && existing.key !== definition.key) {
        throw new Error(`Ambiguous Shopee header alias "${alias}".`);
      }
      aliases.set(normalized, definition);
    }
  }
  return aliases;
}

function isSensitiveHeader(normalized: string): boolean {
  return SENSITIVE_HEADER_TERMS.some((term) => normalized.includes(term));
}

function buildHeaderMapping(
  sheet: ExcelJS.Worksheet,
  definitions: HeaderDefinition[],
  requiredKeys: string[],
  displayName: string,
): HeaderMapping {
  const aliases = aliasMap(definitions);
  const candidates: Array<{
    rowNumber: number;
    columns: Map<string, number>;
    score: number;
    ambiguousFinancialColumns: Array<{ column: number; key: string; label: string }>;
    ambiguousIdentityColumns: Array<{ key: string; first: number; second: number }>;
  }> = [];
  const lastRow = Math.min(sheet.rowCount, MAX_HEADER_SCAN_ROWS);
  for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const columns = new Map<string, number>();
    const ambiguousFinancialColumns: Array<{ column: number; key: string; label: string }> = [];
    const ambiguousFinancialKeys = new Set<string>();
    const ambiguousIdentityColumns: Array<{ key: string; first: number; second: number }> = [];
    let score = 0;
    for (let column = 1; column <= row.cellCount; column += 1) {
      const definition = aliases.get(normalizeHeader(valueAt(row, column)));
      if (!definition) continue;
      if (columns.has(definition.key)) {
        if (!definition.financial) {
          const first = columns.get(definition.key);
          if (first !== undefined) ambiguousIdentityColumns.push({ key: definition.key, first, second: column });
          continue;
        }
        const previousColumn = columns.get(definition.key);
        if (previousColumn !== undefined) {
          ambiguousFinancialColumns.push({
            column: previousColumn,
            key: definition.key,
            label: textAt(row, previousColumn) ?? definition.key,
          });
          columns.delete(definition.key);
        }
        ambiguousFinancialKeys.add(definition.key);
      }
      if (ambiguousFinancialKeys.has(definition.key)) {
        ambiguousFinancialColumns.push({
          column,
          key: definition.key,
          label: textAt(row, column) ?? definition.key,
        });
        score += 1;
        continue;
      }
      columns.set(definition.key, column);
      score += 1;
    }
    if (requiredKeys.every((key) => columns.has(key))) {
      candidates.push({ rowNumber, columns, score, ambiguousFinancialColumns, ambiguousIdentityColumns });
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.rowNumber - right.rowNumber);
  const selected = candidates[0];
  if (!selected) {
    throw new HttpError(400, `Could not identify the header row in the Shopee '${displayName}' sheet. Check its column names.`);
  }
  const ambiguousIdentity = selected.ambiguousIdentityColumns[0];
  if (ambiguousIdentity) {
    throw new HttpError(400, `The '${displayName}' sheet has multiple columns matching "${ambiguousIdentity.key}" (row ${selected.rowNumber}, columns ${ambiguousIdentity.first} and ${ambiguousIdentity.second}).`);
  }
  const knownColumns = new Set([
    ...selected.columns.values(),
    ...selected.ambiguousFinancialColumns.map(({ column }) => column),
  ]);
  const unknownFinancialColumns: Array<{ column: number; label: string }> = [];
  const seenUnknownFinancialHeaders = new Set<string>();
  const addQuarantinedColumn = (column: number, label: string) => {
    const normalized = normalizeHeader(label);
    if (!label || isSensitiveHeader(normalized)) return;
    const uniqueLabel = seenUnknownFinancialHeaders.has(normalized)
      ? `${label} (cột ${column})`
      : label;
    seenUnknownFinancialHeaders.add(normalized);
    unknownFinancialColumns.push({ column, label: uniqueLabel });
  };
  for (const { column, key, label } of selected.ambiguousFinancialColumns) {
    addQuarantinedColumn(column, `${label} (ánh xạ trùng ${key}, cột ${column})`);
  }
  const headerRow = sheet.getRow(selected.rowNumber);
  for (let column = 1; column <= headerRow.cellCount; column += 1) {
    if (knownColumns.has(column)) continue;
    const label = textAt(headerRow, column);
    if (label) addQuarantinedColumn(column, label);
  }
  const definitionsByKey = new Map(definitions.map((definition) => [definition.key, definition]));
  return {
    rowNumber: selected.rowNumber,
    columns: selected.columns,
    definitions: definitionsByKey,
    unknownFinancialColumns,
  };
}

function headerColumn(mapping: HeaderMapping, key: string): number | undefined {
  return mapping.columns.get(key);
}

function cellText(row: ExcelJS.Row, mapping: HeaderMapping, key: string): string | null {
  const column = headerColumn(mapping, key);
  return column === undefined ? null : textAt(row, column);
}

function cellDate(row: ExcelJS.Row, mapping: HeaderMapping, key: string): string | null {
  const column = headerColumn(mapping, key);
  return column === undefined ? null : dateAt(row, column);
}

function financialFields(
  row: ExcelJS.Row,
  mapping: HeaderMapping,
): { mapped: Record<string, number>; unmapped: Record<string, number> } {
  const mapped: Record<string, number> = {};
  const unmapped: Record<string, number> = {};
  for (const [key, column] of mapping.columns) {
    if (!mapping.definitions.get(key)?.financial) continue;
    const amount = amountAt(row, column);
    if (amount !== null) mapped[key] = amount;
  }
  for (const { column, label } of mapping.unknownFinancialColumns) {
    const amount = amountAt(row, column);
    if (amount !== null) unmapped[label] = amount;
  }
  return { mapped, unmapped };
}

function financeKeyParts(finance: { mapped: Record<string, number>; unmapped: Record<string, number> }): Array<string | number> {
  const values: Array<string | number> = [];
  for (const [key, value] of Object.entries(finance.mapped)) values.push(key, value);
  for (const [key, value] of Object.entries(finance.unmapped)) values.push(key, value);
  return values;
}

function keyFor(recordType: ShopeeRecordType, ...parts: Array<string | null | number>): string {
  return createHash("sha256").update(JSON.stringify([recordType, ...parts])).digest("hex");
}

function pushUnique(records: ParsedShopeeRecord[], seen: Set<string>, record: ParsedShopeeRecord): boolean {
  if (seen.has(record.sourceKey)) return false;
  seen.add(record.sourceKey);
  records.push(record);
  return true;
}

function findSheet(workbook: ExcelJS.Workbook, aliases: string[]): ExcelJS.Worksheet | undefined {
  const normalizedAliases = new Set(aliases.map(normalizeLabel));
  return workbook.worksheets.find((sheet) => normalizedAliases.has(normalizeLabel(sheet.name)));
}

function containsRequiredHeaders(
  sheet: ExcelJS.Worksheet,
  definitions: HeaderDefinition[],
  requiredKeys: string[],
): boolean {
  const aliases = aliasMap(definitions);
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, MAX_HEADER_SCAN_ROWS); rowNumber += 1) {
    const keys = new Set<string>();
    const row = sheet.getRow(rowNumber);
    for (let column = 1; column <= row.cellCount; column += 1) {
      const definition = aliases.get(normalizeHeader(valueAt(row, column)));
      if (definition) keys.add(definition.key);
    }
    if (requiredKeys.every((key) => keys.has(key))) return true;
  }
  return false;
}

function findRevenueSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet | undefined {
  const namedSheet = findSheet(workbook, ["Doanh thu", "Revenue", "Revenue Details"]);
  if (namedSheet) return namedSheet;
  const candidates = workbook.worksheets.filter((sheet) =>
    containsRequiredHeaders(sheet, REVENUE_HEADERS, ["recordType", "orderId"]),
  );
  if (candidates.length > 1) {
    throw new HttpError(400, "The workbook has multiple sheets that look like the Shopee revenue report.");
  }
  return candidates[0];
}

function dateInSummary(sheet: ExcelJS.Worksheet | undefined, labels: string[]): string | null {
  if (!sheet) return null;
  const normalizedLabels = new Set(labels.map(normalizeLabel));
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    for (let column = 1; column <= row.cellCount; column += 1) {
      if (!normalizedLabels.has(normalizeLabel(valueAt(row, column)))) continue;
      for (let dateColumn = column + 1; dateColumn <= row.cellCount; dateColumn += 1) {
        const parsedDate = dateAt(row, dateColumn);
        if (parsedDate) return parsedDate;
      }
    }
  }
  return null;
}

function summaryFinancialData(sheet: ExcelJS.Worksheet | undefined): Record<string, number> {
  if (!sheet) return {};
  const aliases = aliasMap(SUMMARY_FINANCE_HEADERS);
  const values: Record<string, number> = {};
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    for (let column = 1; column <= row.cellCount; column += 1) {
      const rawLabel = valueAt(row, column);
      const label = typeof rawLabel === "string" ? rawLabel.replace(/^\s*\d+\s*[.)]\s*/, "") : rawLabel;
      const definition = aliases.get(normalizeHeader(label));
      if (!definition) continue;
      let amount: number | null = null;
      for (let valueColumn = column + 1; valueColumn <= row.cellCount; valueColumn += 1) {
        const nextValue = valueAt(row, valueColumn);
        if (typeof nextValue === "string" && aliases.has(normalizeHeader(nextValue))) break;
        amount = amountAt(row, valueColumn);
        if (amount !== null) break;
      }
      if (amount === null) continue;
      const previous = values[definition.key];
      if (previous !== undefined && previous !== amount) {
        throw new HttpError(400, `The Shopee Summary sheet contains conflicting values for "${definition.key}".`);
      }
      values[definition.key] = amount;
    }
  }
  return values;
}

function reconcileSummaryToIncome(
  summary: Record<string, number>,
  income: Record<string, number>,
): ShopeeReconciliationCheck[] {
  return SUMMARY_INCOME_RECONCILIATION_FIELDS.flatMap(({ summaryField, incomeFields }) => {
    const summaryAmount = summary[summaryField];
    if (summaryAmount === undefined) return [];
    const incomeField = incomeFields.find((field) => income[field] !== undefined);
    if (!incomeField) return [];
    const incomeAmount = income[incomeField] ?? 0;
    const difference = (Math.round(summaryAmount * 100) - Math.round(incomeAmount * 100)) / 100;
    return [{
      summaryField,
      incomeField,
      summaryAmount,
      incomeAmount,
      difference,
      matches: difference === 0,
    }];
  });
}

function addTotals(totals: Record<string, number>, values: Record<string, number>): void {
  for (const [key, value] of Object.entries(values)) {
    totals[key] = (Math.round((totals[key] ?? 0) * 100) + Math.round(value * 100)) / 100;
  }
}

export async function parseShopeeReport(buffer: Buffer): Promise<ParsedShopeeReport> {
  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    // ExcelJS's bundled Buffer type predates the generic Buffer type in @types/node 26.
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new HttpError(400, "The uploaded file is not a readable Excel workbook.");
  }

  const revenueSheet = findRevenueSheet(workbook);
  if (!revenueSheet) throw new HttpError(400, "The workbook must contain a Shopee revenue sheet.");
  const revenueMapping = buildHeaderMapping(
    revenueSheet,
    REVENUE_HEADERS,
    ["recordType", "orderId"],
    revenueSheet.name,
  );
  if (!REVENUE_HEADERS.some(({ key, financial }) => financial && revenueMapping.columns.has(key))
    && revenueMapping.unknownFinancialColumns.length === 0) {
    throw new HttpError(400, `No supported financial columns were found in the Shopee '${revenueSheet.name}' sheet.`);
  }

  const records: ParsedShopeeRecord[] = [];
  const seen = new Set<string>();
  const counts: ParsedShopeeReport["counts"] = {
    ORDER: 0,
    SKU: 0,
    ADJUSTMENT: 0,
    SERVICE_FEE: 0,
    SHIPPING_DISCREPANCY: 0,
  };
  const financeTotals: Record<string, number> = {};
  let sourceRowCount = 0;

  for (let index = revenueMapping.rowNumber + 1; index <= revenueSheet.rowCount; index += 1) {
    const row = revenueSheet.getRow(index);
    const type = normalizeLabel(cellText(row, revenueMapping, "recordType"));
    const recordType = type === "order" || type === "donhang"
      ? "ORDER"
      : type === "sku" || type === "product" || type === "sanpham"
        ? "SKU"
        : null;
    if (!recordType) continue;

    const externalOrderId = cellText(row, revenueMapping, "orderId");
    if (!externalOrderId) continue;
    sourceRowCount += 1;
    const transactionDate = cellDate(row, revenueMapping, "transactionDate");
    const settlementDate = cellDate(row, revenueMapping, "settlementDate");
    const externalProductId = recordType === "SKU" ? cellText(row, revenueMapping, "productId") : null;
    const productName = recordType === "SKU" ? cellText(row, revenueMapping, "productName") : null;
    const extractedFinance = financialFields(row, revenueMapping);
    const financialData = recordType === "ORDER" && Object.keys(extractedFinance.mapped).length
      ? extractedFinance.mapped
      : null;
    const unmappedFinancialData = Object.keys(extractedFinance.unmapped).length
      ? extractedFinance.unmapped
      : null;
    const transactionId = cellText(row, revenueMapping, "transactionId");
    const sourceKey = keyFor(
      recordType,
      transactionId,
      externalOrderId,
      externalProductId,
      transactionDate,
      settlementDate,
    );
    const added = pushUnique(records, seen, {
      recordType,
      sourceKey,
      sourceSheet: revenueSheet.name,
      sourceRow: index,
      externalOrderId,
      externalProductId,
      productName,
      transactionDate,
      settlementDate,
      financialData,
      unmappedFinancialData,
    });
    if (added && recordType === "ORDER" && financialData) addTotals(financeTotals, financialData);
  }

  const adjustmentSheet = findSheet(workbook, ["Adjustment", "Điều chỉnh"]);
  if (adjustmentSheet && adjustmentSheet.rowCount > 1) {
    const mapping = buildHeaderMapping(
      adjustmentSheet,
      ADJUSTMENT_HEADERS,
      ["adjustmentType", "adjustmentAmount", "orderId"],
      adjustmentSheet.name,
    );
    for (let index = mapping.rowNumber + 1; index <= adjustmentSheet.rowCount; index += 1) {
      const row = adjustmentSheet.getRow(index);
      const externalOrderId = cellText(row, mapping, "orderId");
      const adjustmentType = cellText(row, mapping, "adjustmentType");
      const amountColumn = headerColumn(mapping, "adjustmentAmount");
      const amount = amountColumn === undefined ? null : amountAt(row, amountColumn);
      if (!externalOrderId || !adjustmentType || amount === null) continue;
      sourceRowCount += 1;
      const transactionDate = cellDate(row, mapping, "transactionDate");
      const settlementDate = cellDate(row, mapping, "settlementDate");
      const transactionId = cellText(row, mapping, "transactionId");
      const adjustmentData = financialFields(row, mapping);
      const financialData = { adjustmentType, ...adjustmentData.mapped };
      pushUnique(records, seen, {
        recordType: "ADJUSTMENT",
        sourceKey: keyFor("ADJUSTMENT", transactionId, externalOrderId, transactionDate, ...Object.entries(financialData).flat()),
        sourceSheet: adjustmentSheet.name,
        sourceRow: index,
        externalOrderId,
        externalProductId: null,
        productName: null,
        transactionDate,
        settlementDate,
        financialData,
        unmappedFinancialData: Object.keys(adjustmentData.unmapped).length ? adjustmentData.unmapped : null,
      });
    }
  }

  const feeSheet = findSheet(workbook, ["Service Fee Details", "Chi tiết phí dịch vụ"]);
  if (feeSheet && feeSheet.rowCount > 1) {
    const mapping = buildHeaderMapping(feeSheet, SERVICE_FEE_HEADERS, ["orderId"], feeSheet.name);
    if (!SERVICE_FEE_HEADERS.some(({ key, financial }) => financial && mapping.columns.has(key))
      && mapping.unknownFinancialColumns.length === 0) {
      throw new HttpError(400, `No supported fee columns were found in the Shopee '${feeSheet.name}' sheet.`);
    }
    for (let index = mapping.rowNumber + 1; index <= feeSheet.rowCount; index += 1) {
      const row = feeSheet.getRow(index);
      const externalOrderId = cellText(row, mapping, "orderId");
      if (!externalOrderId) continue;
      const extractedFinance = financialFields(row, mapping);
      if (!Object.keys(extractedFinance.mapped).length && !Object.keys(extractedFinance.unmapped).length) continue;
      sourceRowCount += 1;
      pushUnique(records, seen, {
        recordType: "SERVICE_FEE",
        sourceKey: keyFor("SERVICE_FEE", externalOrderId, ...financeKeyParts(extractedFinance)),
        sourceSheet: feeSheet.name,
        sourceRow: index,
        externalOrderId,
        externalProductId: null,
        productName: null,
        transactionDate: null,
        settlementDate: null,
        financialData: Object.keys(extractedFinance.mapped).length ? extractedFinance.mapped : null,
        unmappedFinancialData: Object.keys(extractedFinance.unmapped).length ? extractedFinance.unmapped : null,
      });
    }
  }

  const shippingSheet = findSheet(workbook, ["Shipping Fee Discrepancy", "Chênh lệch phí vận chuyển"]);
  if (shippingSheet && shippingSheet.rowCount > 1) {
    const mapping = buildHeaderMapping(shippingSheet, SHIPPING_HEADERS, ["orderId"], shippingSheet.name);
    if (!SHIPPING_HEADERS.some(({ key, financial }) => financial && mapping.columns.has(key))
      && mapping.unknownFinancialColumns.length === 0) {
      throw new HttpError(400, `No supported shipping-fee columns were found in the Shopee '${shippingSheet.name}' sheet.`);
    }
    for (let index = mapping.rowNumber + 1; index <= shippingSheet.rowCount; index += 1) {
      const row = shippingSheet.getRow(index);
      const externalOrderId = cellText(row, mapping, "orderId");
      if (!externalOrderId) continue;
      const extractedFinance = financialFields(row, mapping);
      if (!Object.keys(extractedFinance.mapped).length && !Object.keys(extractedFinance.unmapped).length) continue;
      sourceRowCount += 1;
      pushUnique(records, seen, {
        recordType: "SHIPPING_DISCREPANCY",
        sourceKey: keyFor("SHIPPING_DISCREPANCY", externalOrderId, ...financeKeyParts(extractedFinance)),
        sourceSheet: shippingSheet.name,
        sourceRow: index,
        externalOrderId,
        externalProductId: null,
        productName: null,
        transactionDate: null,
        settlementDate: null,
        financialData: Object.keys(extractedFinance.mapped).length ? extractedFinance.mapped : null,
        unmappedFinancialData: Object.keys(extractedFinance.unmapped).length ? extractedFinance.unmapped : null,
      });
    }
  }

  const orderRecords = records.filter((record) => record.recordType === "ORDER");
  if (!orderRecords.length) {
    throw new HttpError(400, `No supported order rows were found in the Shopee '${revenueSheet.name}' sheet.`);
  }
  if (!orderRecords.some((record) =>
    Object.keys(record.financialData ?? {}).length > 0
    || Object.keys(record.unmappedFinancialData ?? {}).length > 0,
  )) {
    throw new HttpError(400, `No numeric financial data was found in the Shopee '${revenueSheet.name}' sheet.`);
  }
  for (const record of records) counts[record.recordType] += 1;
  const unmappedSummary = new Map<string, UnmappedFieldSummary>();
  for (const record of records) {
    for (const header of Object.keys(record.unmappedFinancialData ?? {})) {
      const key = `${record.sourceSheet}\u0000${normalizeHeader(header)}`;
      const summary = unmappedSummary.get(key);
      if (summary) summary.occurrences += 1;
      else unmappedSummary.set(key, { sourceSheet: record.sourceSheet, header, occurrences: 1 });
    }
  }

  const summarySheet = findSheet(workbook, ["Summary", "Tổng quan"]);
  const summaryFinance = summaryFinancialData(summarySheet);
  return {
    mappingVersion: SHOPEE_MAPPING_VERSION,
    fileHash: createHash("sha256").update(buffer).digest("hex"),
    reportFrom: dateInSummary(summarySheet, ["Từ", "From", "Ngày bắt đầu", "Start Date"]),
    reportTo: dateInSummary(summarySheet, ["Đến", "To", "Ngày kết thúc", "End Date"]),
    sourceRowCount,
    records,
    counts,
    financeTotals,
    summaryFinancialData: summaryFinance,
    reconciliations: reconcileSummaryToIncome(summaryFinance, financeTotals),
    unmappedFieldSummaries: [...unmappedSummary.values()].sort((left, right) =>
      left.sourceSheet.localeCompare(right.sourceSheet, "vi") || left.header.localeCompare(right.header, "vi"),
    ),
  };
}
