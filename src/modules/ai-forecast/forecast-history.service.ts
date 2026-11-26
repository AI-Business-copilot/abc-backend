import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { addDays, businessToday, daysBetween, verifiedStockoutDays } from "../ai-insights/snapshot/build-snapshot";
import { HttpError } from "../../shared/http/http-error";
import type { NextDayForecast } from "./forecast";

type Horizon = 7 | 14 | 28;
const HORIZONS: Horizon[] = [7, 14, 28];
const MAX_HISTORY_DAYS = 730;

function evaluateWindow(
  start: string,
  days: Horizon,
  predicted: number,
  availableAt: Date | null,
  firstDay: string,
  completeThrough: string,
  sales: number[],
  stockout: Array<boolean | null>,
) {
  const end = addDays(start, days - 1);
  const offset = daysBetween(firstDay, start);
  const partialStart = availableAt !== null && availableAt.getTime() >= Date.parse(`${start}T00:00:00+07:00`);
  const base = { days, start, end, predicted, partialStart };
  if (end > completeThrough) return { ...base, status: "PENDING" as const, actual: null, absoluteError: null, stockoutDays: null, unknownDays: null };
  if (offset < 0 || offset + days > sales.length || offset + days > stockout.length) {
    return { ...base, status: "OUTSIDE_HISTORY" as const, actual: null, absoluteError: null, stockoutDays: null, unknownDays: null };
  }
  const flags = stockout.slice(offset, offset + days);
  const actual = sales.slice(offset, offset + days).reduce((sum, qty) => sum + qty, 0);
  const stockoutDays = flags.filter((flag) => flag === true).length;
  const unknownDays = flags.filter((flag) => flag === null).length;
  const status = unknownDays ? "UNKNOWN_STOCK" : stockoutDays ? "STOCKOUT" :
    availableAt === null ? "PUBLICATION_UNKNOWN" : partialStart ? "PARTIAL_START" : "COMPARABLE";
  return { ...base, status, actual, absoluteError: Math.abs(predicted - actual), stockoutDays, unknownDays };
}

export function forecastAvailableAt(issuedAt: Date, finishedAt: Date | null): Date | null {
  if (finishedAt === null) return null;
  return issuedAt > finishedAt ? issuedAt : finishedAt;
}

export function evaluateForecast(
  asOf: string,
  availableAt: Date | null,
  predictions: Record<Horizon, number>,
  firstDay: string,
  completeThrough: string,
  sales: number[],
  stockout: Array<boolean | null>,
) {
  const start = addDays(asOf, 1);
  return HORIZONS.map((days) => evaluateWindow(start, days, predictions[days], availableAt, firstDay, completeThrough, sales, stockout));
}

export function evaluateNextDayForecast(
  asOf: string,
  availableAt: Date | null,
  predictions: Record<Horizon, number>,
  firstDay: string,
  completeThrough: string,
  sales: number[],
  stockout: Array<boolean | null>,
) {
  const start = addDays(asOf, 2);
  return HORIZONS.map((days) => evaluateWindow(start, days, predictions[days], availableAt, firstDay, completeThrough, sales, stockout));
}

export function evaluateForecastSegments(
  asOf: string,
  availableAt: Date | null,
  predictions: Record<Horizon, number>,
  firstDay: string,
  completeThrough: string,
  sales: number[],
  stockout: Array<boolean | null>,
) {
  return [
    { start: addDays(asOf, 8), days: 7 as const, predicted: predictions[14] - predictions[7] },
    { start: addDays(asOf, 15), days: 14 as const, predicted: predictions[28] - predictions[14] },
  ].map(({ start, days, predicted }) =>
    evaluateWindow(start, days, predicted, availableAt, firstDay, completeThrough, sales, stockout));
}

function readTotals(totals: Prisma.JsonValue | undefined) {
  if (!totals || Array.isArray(totals) || typeof totals !== "object") throw new HttpError(500, "Lịch sử dự báo không có tổng dự báo.");
  const { d7, d14, d28 } = totals;
  if (typeof d7 !== "number" || typeof d14 !== "number" || typeof d28 !== "number" ||
      !Number.isFinite(d7) || !Number.isFinite(d14) || !Number.isFinite(d28) || d7 < 0 || d14 < d7 || d28 < d14) {
    throw new HttpError(500, "Tổng trong lịch sử dự báo không hợp lệ.");
  }
  return { 7: d7, 14: d14, 28: d28 };
}

function readForecast(value: Prisma.JsonValue) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new HttpError(500, "Lịch sử dự báo không hợp lệ.");
  const predictions = readTotals(value.totals);
  const next = value.nextDayForecast;
  let nextDayForecast: NextDayForecast | null = null;
  if (next !== undefined && next !== null) {
    if (typeof next !== "object" || Array.isArray(next)) throw new HttpError(500, "Dự báo ngày đầy đủ trong lịch sử không hợp lệ.");
    if (next.status === "OK" && next.policy === "next-day-v1") {
      const amounts = readTotals(next.totals);
      nextDayForecast = { status: "OK", policy: "next-day-v1", totals: { d7: amounts[7], d14: amounts[14], d28: amounts[28] } };
    } else if (next.status === "UNAVAILABLE" && (next.reason === "MODEL_NOT_CONFIGURED" || next.reason === "SERVICE_NOT_SUPPORTED")) {
      nextDayForecast = { status: "UNAVAILABLE", reason: next.reason };
    } else {
      throw new HttpError(500, "Dự báo ngày đầy đủ trong lịch sử không hợp lệ.");
    }
  }
  return { predictions, nextDayForecast, model: value.model, modelVersion: value.modelVersion };
}

export async function forecastHistory(businessId: string, variantId: string) {
  const today = await businessToday();
  return prisma.$transaction((tx) => forecastHistoryInTransaction(tx, businessId, variantId, today),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 });
}

export async function forecastHistoryInTransaction(tx: Prisma.TransactionClient, businessId: string, variantId: string, today: string) {
    const completeThrough = addDays(today, -1);
    const histories = await tx.$queryRaw<Array<{ id: string; runId: string; asOf: Date; issuedAt: Date; finishedAt: Date | null; result: Prisma.JsonValue }>>`
      SELECT h."id", h."run_id" AS "runId", h."as_of" AS "asOf", h."issued_at" AS "issuedAt",
             r."finished_at" AS "finishedAt", h."result"
      FROM "ai_forecast_history" h
      JOIN "ai_insight_runs" r ON r."id" = h."run_id" AND r."business_id" = h."business_id" AND r."status" = 'SUCCEEDED'
      WHERE h."business_id" = ${businessId}::uuid AND h."variant_id" = ${variantId}::uuid
      ORDER BY h."issued_at" DESC LIMIT 20
    `;
    if (!histories.length) return { items: [] };
    const earliest = histories.map((row) => row.asOf.toISOString().slice(0, 10)).sort()[0];
    const firstDay = [addDays(earliest, 1), addDays(today, -MAX_HISTORY_DAYS)].sort()[1];
    const [totalsRows, stockRows, changes, salesRows] = await Promise.all([
      tx.$queryRaw<Array<{ total: number; count: number; firstDay: string | null; invalid: number }>>`
        SELECT COALESCE(SUM("quantity_changed"), 0)::int AS "total", COUNT(*)::int AS "count",
               ((MIN("created_at") AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::text AS "firstDay",
               COUNT(*) FILTER (WHERE "created_at" IS NULL OR ("created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date > ${today}::date)::int AS "invalid"
        FROM "inventory_ledger" WHERE "business_id" = ${businessId}::uuid AND "variant_id" = ${variantId}::uuid
      `,
      tx.$queryRaw<Array<{ quantity: number }>>`
        SELECT COALESCE(SUM("quantity_on_hand"), 0)::int AS "quantity"
        FROM "inventory_balances" WHERE "business_id" = ${businessId}::uuid AND "variant_id" = ${variantId}::uuid
      `,
      tx.$queryRaw<Array<{ day: string; change: number; sold: number }>>`
        SELECT (("created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::text AS "day", SUM("quantity_changed")::int AS "change",
               COALESCE(-SUM("quantity_changed") FILTER (WHERE "transaction_type" = 'POS_SALE'), 0)::int AS "sold"
        FROM "inventory_ledger" WHERE "business_id" = ${businessId}::uuid AND "variant_id" = ${variantId}::uuid
          AND ("created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN ${firstDay}::date AND ${today}::date
        GROUP BY 1
      `,
      tx.$queryRaw<Array<{ day: string; units: number }>>`
        SELECT ((o."created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::text AS "day", SUM(i."quantity")::int AS "units"
        FROM "orders" o JOIN "order_items" i ON i."order_id" = o."id"
        WHERE o."business_id" = ${businessId}::uuid AND i."variant_id" = ${variantId}::uuid AND o."status" = 'COMPLETED'
          AND (o."created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN ${firstDay}::date AND ${completeThrough}::date
        GROUP BY 1
      `,
    ]);
    const length = daysBetween(firstDay, today) + 1;
    const dailyChanges = Array<number>(length).fill(0);
    const ledgerSales = Array<number>(length).fill(0);
    const sales = Array<number>(length - 1).fill(0);
    for (const row of changes) {
      const index = daysBetween(firstDay, row.day);
      if (index >= 0 && index < length) { dailyChanges[index] = row.change; ledgerSales[index] = row.sold; }
    }
    for (const row of salesRows) {
      const index = daysBetween(firstDay, row.day);
      if (index >= 0 && index < sales.length) sales[index] = row.units;
    }
    const totals = totalsRows[0];
    const firstLedgerIndex = totals.firstDay ? Math.max(0, daysBetween(firstDay, totals.firstDay)) : 0;
    const flags = verifiedStockoutDays(stockRows[0].quantity, dailyChanges, ledgerSales, sales, totals.total, totals.invalid ? 0 : totals.count, firstLedgerIndex);
    return {
      items: histories.map((history) => {
        const asOf = history.asOf.toISOString().slice(0, 10);
        const forecast = readForecast(history.result);
        const availableAt = forecastAvailableAt(history.issuedAt, history.finishedAt);
        const nextDay = forecast.nextDayForecast;
        return {
          id: history.id, runId: history.runId, asOf, issuedAt: history.issuedAt, finishedAt: history.finishedAt,
          model: forecast.model, modelVersion: forecast.modelVersion,
          evaluations: evaluateForecast(asOf, availableAt, forecast.predictions, firstDay, completeThrough, sales, flags),
          segmentEvaluations: evaluateForecastSegments(asOf, availableAt, forecast.predictions, firstDay, completeThrough, sales, flags),
          nextDayEvaluation: nextDay?.status === "OK" ? {
            status: "OK" as const,
            evaluations: evaluateNextDayForecast(asOf, availableAt,
              { 7: nextDay.totals.d7, 14: nextDay.totals.d14, 28: nextDay.totals.d28 },
              firstDay, completeThrough, sales, flags),
          } : { status: "UNAVAILABLE" as const, reason: nextDay?.reason ?? "NOT_RECORDED" },
        };
      }),
    };
}
