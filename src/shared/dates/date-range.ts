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

export function vietnamToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function completedDaysRange(days: number) {
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError("days must be a positive integer.");
  const to = metricDate(vietnamToday());
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days + 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function lastCompletedWeekRange(now = new Date()) {
  const end = metricDate(vietnamToday(now));
  end.setUTCDate(end.getUTCDate() - ((end.getUTCDay() + 6) % 7) - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
