import { HttpError } from "../http/http-error";

export const MAX_RANGE_DAYS = 366;

export function parseDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${field} must use YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${field} is not a valid date.`);
  }
  return value;
}

export function dateRange(fromValue: unknown, toValue: unknown) {
  const from = parseDate(fromValue, "from");
  const to = parseDate(toValue, "to");
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);
  if (toDate < fromDate) throw new HttpError(400, "to must not be earlier than from.");
  const dayCount = Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
  if (dayCount > MAX_RANGE_DAYS) throw new HttpError(400, `The date range cannot exceed ${MAX_RANGE_DAYS} days.`);
  return { from, to, dayCount };
}

export function metricDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
