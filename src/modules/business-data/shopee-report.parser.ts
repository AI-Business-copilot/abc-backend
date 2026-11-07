import { createHash } from "node:crypto";
import ExcelJS from "exceljs";

import { HttpError } from "../../shared/http/http-error";

export type ShopeeRecordType = "ORDER" | "SKU" | "ADJUSTMENT" | "SERVICE_FEE" | "SHIPPING_DISCREPANCY";

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
}

export interface ParsedShopeeReport {
  fileHash: string;
  reportFrom: string | null;
  reportTo: string | null;
  sourceRowCount: number;
  records: ParsedShopeeRecord[];
  counts: Record<ShopeeRecordType, number>;
  financeTotals: Record<string, number>;
}

const REVENUE_FIELDS: Record<number, string> = {
  13: "sellerReceivedAmount",
  14: "productGrossAmount",
  15: "refundAmount",
  16: "buyerShippingPaid",
  17: "actualShippingFee",
  18: "platformShippingSubsidy",
  19: "returnShippingFee",
  20: "pishipShippingRefund",
  21: "failedDeliveryReturnShippingFee",
  22: "platformProductSubsidy",
  23: "sellerVoucherDiscount",
  24: "sellerCoFundedVoucherDiscount",
  25: "sellerCoinDiscount",
  26: "sellerCoFundedCoinDiscount",
  27: "fixedPlatformFee",
  28: "serviceFee",
  29: "transactionFee",
  30: "affiliateFee",
  31: "pishipServiceFee",
  32: "automaticTopUp",
  33: "vat",
  34: "personalIncomeTax",
  35: "buyerInstallationFee",
  36: "actualInstallationFee",
  37: "sellerTradeInBonus",
  44: "sellerShippingSupport",
  48: "lostParcelCompensation",
  49: "productPaidAfterPromotion",
  50: "shopeeCoinDiscount",
  51: "shopeeVoucherDiscount",
  52: "bankPromotionDiscount",
  53: "shopeeBankPromotionDiscount",
};

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

function dateAt(row: ExcelJS.Row, column: number): string | null {
  const value = valueAt(row, column);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const normalized = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isNaN(Date.parse(`${normalized}T00:00:00.000Z`)) ? null : normalized;
}

function amountAt(row: ExcelJS.Row, column: number): number | null {
  const value = valueAt(row, column);
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === "-") return null;
  const normalized = text.replace(/[₫đ\s]/gi, "").replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}

function amountFields(row: ExcelJS.Row, columns: Record<number, string>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [column, key] of Object.entries(columns)) {
    const amount = amountAt(row, Number(column));
    if (amount !== null) result[key] = amount;
  }
  return result;
}

function keyFor(recordType: ShopeeRecordType, ...parts: Array<string | null | number>): string {
  return createHash("sha256").update(JSON.stringify([recordType, ...parts])).digest("hex");
}

function pushUnique(
  records: ParsedShopeeRecord[],
  seen: Set<string>,
  record: ParsedShopeeRecord,
): void {
  if (seen.has(record.sourceKey)) return;
  seen.add(record.sourceKey);
  records.push(record);
}

function dateInSummary(sheet: ExcelJS.Worksheet | undefined, label: string): string | null {
  if (!sheet) return null;
  for (let index = 1; index <= sheet.rowCount; index += 1) {
    const row = sheet.getRow(index);
    if (textAt(row, 1)?.toLocaleLowerCase("vi-VN") === label.toLocaleLowerCase("vi-VN")) {
      return dateAt(row, 2);
    }
  }
  return null;
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

  const revenueSheet = workbook.getWorksheet("Doanh thu");
  if (!revenueSheet || revenueSheet.rowCount < 4) {
    throw new HttpError(400, "The workbook must contain the Shopee 'Doanh thu' sheet.");
  }
  const headers = revenueSheet.getRow(3);
  if (textAt(headers, 2) !== "Đơn hàng / Sản phẩm" || textAt(headers, 3) !== "Mã đơn hàng") {
    throw new HttpError(400, "The 'Doanh thu' sheet does not match the supported Shopee report template.");
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

  for (let index = 4; index <= revenueSheet.rowCount; index += 1) {
    const row = revenueSheet.getRow(index);
    const recordType = textAt(row, 2);
    if (recordType !== "Order" && recordType !== "Sku") continue;
    const externalOrderId = textAt(row, 3);
    if (!externalOrderId) continue;
    sourceRowCount += 1;
    const transactionDate = dateAt(row, 8);
    const settlementDate = dateAt(row, 9);
    const externalProductId = recordType === "Sku" ? textAt(row, 6) : null;
    const productName = recordType === "Sku" ? textAt(row, 7) : null;
    const financialData = recordType === "Order" ? amountFields(row, REVENUE_FIELDS) : null;
    const normalizedType = recordType === "Order" ? "ORDER" : "SKU";
    const transactionId = textAt(row, 1);
    const sourceKey = keyFor(
      normalizedType,
      transactionId,
      externalOrderId,
      externalProductId,
      transactionDate,
      settlementDate,
    );
    pushUnique(records, seen, {
      recordType: normalizedType,
      sourceKey,
      sourceSheet: revenueSheet.name,
      sourceRow: index,
      externalOrderId,
      externalProductId,
      productName,
      transactionDate,
      settlementDate,
      financialData,
    });
    if (normalizedType === "ORDER" && financialData) addTotals(financeTotals, financialData);
  }

  const adjustmentSheet = workbook.getWorksheet("Adjustment");
  if (adjustmentSheet) {
    for (let index = 18; index <= adjustmentSheet.rowCount; index += 1) {
      const row = adjustmentSheet.getRow(index);
      const externalOrderId = textAt(row, 6);
      const adjustmentType = textAt(row, 3);
      const amount = amountAt(row, 5);
      if (!externalOrderId || !adjustmentType || amount === null) continue;
      sourceRowCount += 1;
      const transactionDate = dateAt(row, 2);
      const settlementDate = dateAt(row, 7);
      const transactionId = textAt(row, 1);
      const financialData = { adjustmentType, adjustmentAmount: amount };
      pushUnique(records, seen, {
        recordType: "ADJUSTMENT",
        sourceKey: keyFor("ADJUSTMENT", transactionId, externalOrderId, transactionDate, adjustmentType, amount),
        sourceSheet: adjustmentSheet.name,
        sourceRow: index,
        externalOrderId,
        externalProductId: null,
        productName: null,
        transactionDate,
        settlementDate,
        financialData,
      });
    }
  }

  const feeSheet = workbook.getWorksheet("Service Fee Details");
  if (feeSheet) {
    for (let index = 3; index <= feeSheet.rowCount; index += 1) {
      const row = feeSheet.getRow(index);
      const externalOrderId = textAt(row, 2);
      if (!externalOrderId) continue;
      const financialData = amountFields(row, {
        3: "voucherPackageFee",
        4: "livePackageFee",
        5: "experiencePackageFee",
        6: "shippingPromotionPackageFee",
      });
      if (!Object.keys(financialData).length) continue;
      sourceRowCount += 1;
      pushUnique(records, seen, {
        recordType: "SERVICE_FEE",
        sourceKey: keyFor("SERVICE_FEE", externalOrderId, ...Object.values(financialData)),
        sourceSheet: feeSheet.name,
        sourceRow: index,
        externalOrderId,
        externalProductId: null,
        productName: null,
        transactionDate: null,
        settlementDate: null,
        financialData,
      });
    }
  }

  const shippingSheet = workbook.getWorksheet("Shipping Fee Discrepancy");
  if (shippingSheet) {
    for (let index = 3; index <= shippingSheet.rowCount; index += 1) {
      const row = shippingSheet.getRow(index);
      const externalOrderId = textAt(row, 1);
      if (!externalOrderId) continue;
      const financialData = amountFields(row, {
        2: "estimatedShippingFee",
        3: "actualShippingFee",
      });
      sourceRowCount += 1;
      pushUnique(records, seen, {
        recordType: "SHIPPING_DISCREPANCY",
        sourceKey: keyFor("SHIPPING_DISCREPANCY", externalOrderId, ...Object.values(financialData)),
        sourceSheet: shippingSheet.name,
        sourceRow: index,
        externalOrderId,
        externalProductId: null,
        productName: null,
        transactionDate: null,
        settlementDate: null,
        financialData: Object.keys(financialData).length ? financialData : null,
      });
    }
  }

  if (!records.some((record) => record.recordType === "ORDER")) {
    throw new HttpError(400, "No supported order rows were found in the 'Doanh thu' sheet.");
  }
  for (const record of records) counts[record.recordType] += 1;

  return {
    fileHash: createHash("sha256").update(buffer).digest("hex"),
    reportFrom: dateInSummary(workbook.getWorksheet("Summary"), "Từ"),
    reportTo: dateInSummary(workbook.getWorksheet("Summary"), "Đến"),
    sourceRowCount,
    records,
    counts,
    financeTotals,
  };
}
