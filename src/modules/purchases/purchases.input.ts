import { Prisma } from "@prisma/client";
import { HttpError } from "../../shared/http/http-error";
import { uuid } from "./purchases.query";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "JSON object required.");
  return value as Record<string, unknown>;
}

export function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new HttpError(400, `Invalid ${name} (1-${max} characters).`);
  return value.trim();
}

export function quantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) throw new HttpError(400, "Quantity must be a positive 32-bit integer.");
  return value;
}

export function money(value: unknown, name: string, digits = 12): Prisma.Decimal {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+(\.\d{1,2})?$/.test(String(value))) throw new HttpError(400, `${name} must be non-negative with at most 2 decimal places.`);
  const amount = new Prisma.Decimal(value);
  if (amount.gte(new Prisma.Decimal(10).pow(digits - 2))) throw new HttpError(400, `${name} exceeds database precision.`);
  return amount;
}

export function date(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${name} must use YYYY-MM-DD.`);
  const result = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) throw new HttpError(400, `Invalid ${name}.`);
  return result;
}

function items(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw new HttpError(400, "items must contain 1-500 lines.");
  return value.map(object);
}

export function purchaseToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export function orderInput(value: unknown) {
  const body = object(value);
  const lines = items(body.items).map((item) => ({
    variantId: uuid(item.variantId, "variantId"), orderedQty: quantity(item.orderedQty), unitPrice: money(item.unitPrice, "unitPrice"),
  }));
  if (new Set(lines.map((item) => item.variantId)).size !== lines.length) throw new HttpError(400, "Duplicate SKU in purchase order.");
  const orderDate = date(body.orderDate, "orderDate") ?? new Date(`${purchaseToday()}T00:00:00.000Z`);
  if (body.expectedDeliveryDate === undefined || body.expectedDeliveryDate === null || body.expectedDeliveryDate === "") throw new HttpError(400, "Vui lòng chọn ngày giao dự kiến.");
  const expectedDeliveryDate = date(body.expectedDeliveryDate, "expectedDeliveryDate")!;
  if (expectedDeliveryDate < orderDate) throw new HttpError(400, "Ngày giao dự kiến không được trước ngày đặt.");
  for (const line of lines) money(line.unitPrice.mul(line.orderedQty).toFixed(2), "subtotal", 14);
  return { poCode: requiredText(body.poCode, "poCode", 50), supplierId: uuid(body.supplierId, "supplierId"), orderDate, expectedDeliveryDate, items: lines };
}

export function receiptInput(value: unknown) {
  const body = object(value);
  const lines = items(body.items).map((item) => {
    const manufacturingDate = date(item.manufacturingDate, "manufacturingDate");
    const expirationDate = date(item.expirationDate, "expirationDate");
    if (manufacturingDate && expirationDate && manufacturingDate > expirationDate) throw new HttpError(400, "Manufacturing date cannot follow expiration date.");
    return {
      poItemId: uuid(item.poItemId, "poItemId"), receivedQty: quantity(item.receivedQty), actualCost: money(item.actualCost, "actualCost"),
      lotNumber: item.lotNumber === undefined ? undefined : requiredText(item.lotNumber, "lotNumber", 100),
      manufacturingDate, expirationDate,
    };
  });
  const totalAmount = lines.reduce((sum, line) => sum.plus(line.actualCost.mul(line.receivedQty)), new Prisma.Decimal(0));
  money(totalAmount.toFixed(2), "totalAmount", 14);
  const paidAmount = money(body.paidAmount ?? 0, "paidAmount", 14);
  if (paidAmount.gt(totalAmount)) throw new HttpError(400, "Payment cannot exceed receipt total.");
  return { receiptCode: requiredText(body.receiptCode, "receiptCode", 50), paidAmount, totalAmount, items: lines };
}
