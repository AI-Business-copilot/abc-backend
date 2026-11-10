import { HttpError } from "../../shared/http/http-error";

export type PurchaseQuery = Record<string, unknown>;

export function text(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string.`);
  const result = value.trim();
  if (result.length > 255) throw new HttpError(400, `${name} is too long.`);
  return result || undefined;
}

export function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, `${name} must be a UUID.`);
  }
  return value.toLowerCase();
}

function integer(value: unknown, fallback: number, max: number, name: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new HttpError(400, `${name} must be a positive integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new HttpError(400, `${name} is out of range.`);
  return result;
}

export function filters(query: PurchaseQuery, statuses: readonly string[]) {
  const page = integer(query.page, 1, 1_000_000, "page");
  const pageSize = integer(query.pageSize, 20, 100, "pageSize");
  const status = text(query.status, "status")?.toUpperCase();
  if (status && !statuses.includes(status)) throw new HttpError(400, "Invalid status.");
  const from = day(query.from, "from");
  const to = day(query.to, "to");
  if (from && to && from > to) throw new HttpError(400, "from must be on or before to.");
  return {
    page, pageSize, skip: (page - 1) * pageSize, status,
    search: text(query.search, "search"),
    supplierId: query.supplierId === undefined ? undefined : uuid(query.supplierId, "supplierId"),
    poId: query.poId === undefined ? undefined : uuid(query.poId, "poId"),
    dateRange: from || to ? { gte: from, lt: to ? new Date(to.getTime() + 86_400_000) : undefined } : undefined,
  };
}

function day(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${name} must use YYYY-MM-DD.`);
  const result = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) throw new HttpError(400, `Invalid ${name}.`);
  return result;
}

export function pagination(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}
