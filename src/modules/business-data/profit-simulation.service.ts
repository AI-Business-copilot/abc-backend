import { Prisma } from "@prisma/client";

import { HttpError } from "../../shared/http/http-error";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { addDays } from "../ai-insights/snapshot/build-snapshot";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SimulationDecimal = Prisma.Decimal.clone({ precision: 50, rounding: Prisma.Decimal.ROUND_HALF_UP });
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const day = (value: Date) => value.toISOString().slice(0, 10);

function variantId(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value)) throw new HttpError(400, "Mã SKU không hợp lệ.");
  return value;
}

function horizon(value: unknown): 7 | 14 | 28 {
  if (value !== 7 && value !== 14 && value !== 28) throw new HttpError(400, "Kỳ mô phỏng phải là 7, 14 hoặc 28 ngày.");
  return value;
}

function amount(value: unknown, name: string, maximum: string) {
  if (typeof value !== "string" || !/^\d{1,13}(?:\.\d{1,2})?$/.test(value)) {
    throw new HttpError(400, `${name} phải là số không âm, tối đa 2 chữ số thập phân.`);
  }
  const parsed = new SimulationDecimal(value);
  if (parsed.gt(maximum)) throw new HttpError(400, `${name} vượt giới hạn cho phép (${maximum}).`);
  return parsed;
}

export function calculateScenario(value: unknown) {
  if (!isObject(value)) throw new HttpError(400, "Kịch bản không hợp lệ.");
  const quantity = amount(value.quantity, "Số lượng", "1000000");
  const price = amount(value.price, "Giá bán", "10000000000");
  const cost = amount(value.unitCost, "Giá vốn", "10000000000");
  const discount = amount(value.discountPercent, "Giảm giá", "100");
  const expense = value.operatingExpense === null ? null : amount(value.operatingExpense, "Chi phí vận hành", "1000000000000");
  const gross = quantity.mul(price).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const discountAmount = quantity.mul(price).mul(discount).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const revenue = gross.minus(discountAmount);
  const cogs = quantity.mul(cost).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const profit = revenue.minus(cogs);
  return {
    inputs: {
      quantity: quantity.toFixed(2), price: price.toFixed(2), unitCost: cost.toFixed(2),
      discountPercent: discount.toFixed(2), operatingExpense: expense?.toFixed(2) ?? null,
    },
    grossSales: gross.toFixed(2), discountAmount: discountAmount.toFixed(2),
    revenue: revenue.toFixed(2), cogs: cogs.toFixed(2), grossProfit: profit.toFixed(2),
    afterExpense: expense === null ? null : profit.minus(expense).toFixed(2),
  };
}

export function calculateComparison(baseline: unknown, scenario: unknown) {
  const base = calculateScenario(baseline);
  const alternative = calculateScenario(scenario);
  const difference = (current: string, previous: string) => {
    const a = new SimulationDecimal(current);
    const b = new SimulationDecimal(previous);
    return { difference: a.minus(b).toFixed(2), percent: b.gt(0) ? a.minus(b).mul(100).div(b).toFixed(2) : null };
  };
  return {
    baseline: base, scenario: alternative,
    changes: {
      revenue: difference(alternative.revenue, base.revenue),
      cogs: difference(alternative.cogs, base.cogs),
      grossProfit: difference(alternative.grossProfit, base.grossProfit),
      afterExpense: base.afterExpense !== null && alternative.afterExpense !== null
        ? difference(alternative.afterExpense, base.afterExpense) : null,
    },
  };
}

type Run = { id: string; status: string; dataAsOf: Date; finishedAt: Date | null; summary: Prisma.JsonValue };
type Forecast = { runId: string | null; asOf: Date; status: string; model: string | null; confidence: string | null; result: Prisma.JsonValue; updatedAt: Date };

export function simulationForecast(today: string, latest: Run | null, forecast: Forecast | null) {
  const unavailable = (reason: string) => ({ status: "UNAVAILABLE" as const, reason });
  if (!latest) return unavailable("Chưa có lần phân tích dự báo.");
  if (latest.status !== "SUCCEEDED" || !latest.finishedAt || !isObject(latest.summary) || latest.summary.publicationVersion !== 1) {
    return unavailable("Lần phân tích gần nhất chưa hoàn tất hoặc chưa công bố đầy đủ.");
  }
  if (latest.summary.forecastStatus !== "READY" || day(latest.dataAsOf) !== addDays(today, -1)) {
    return unavailable("Dự báo chưa sẵn sàng hoặc dữ liệu không đến hết hôm qua.");
  }
  if (!forecast || forecast.runId !== latest.id || day(forecast.asOf) !== day(latest.dataAsOf)) {
    return unavailable("SKU không có dự báo thuộc lần phân tích mới nhất.");
  }
  if (forecast.status === "INSUFFICIENT_DATA") return unavailable("SKU chưa đủ dữ liệu để dự báo.");
  if (forecast.status !== "OK" || !isObject(forecast.result)) throw new HttpError(500, "Dữ liệu dự báo của SKU không hợp lệ.");
  const next = forecast.result.nextDayForecast;
  if (next === null || next === undefined ||
      (isObject(next) && next.status === "UNAVAILABLE" &&
        (next.reason === "MODEL_NOT_CONFIGURED" || next.reason === "SERVICE_NOT_SUPPORTED"))) {
    return unavailable("Không có dự báo cho kỳ ngày đầy đủ.");
  }
  if (!isObject(next) || next.status !== "OK" || next.policy !== "next-day-v1" || !isObject(next.totals)) {
    throw new HttpError(500, "Dự báo kỳ ngày đầy đủ không hợp lệ.");
  }
  const { d7, d14, d28 } = next.totals;
  if (typeof d7 !== "number" || typeof d14 !== "number" || typeof d28 !== "number" ||
      !Number.isFinite(d7) || !Number.isFinite(d14) || !Number.isFinite(d28) ||
      d7 < 0 || d14 < d7 || d28 < d14) throw new HttpError(500, "Tổng dự báo không hợp lệ.");
  const start = addDays(day(forecast.asOf), 2);
  const availableAt = forecast.updatedAt > latest.finishedAt ? forecast.updatedAt : latest.finishedAt;
  if (availableAt.getTime() >= Date.parse(`${start}T00:00:00+07:00`)) {
    return unavailable("Dự báo được công bố sau khi kỳ bắt đầu.");
  }
  return {
    status: "READY" as const, start, dataAsOf: day(forecast.asOf), finishedAt: latest.finishedAt,
    model: forecast.model, confidence: forecast.confidence,
    modelVersion: typeof forecast.result.modelVersion === "string" ? forecast.result.modelVersion : null,
    datasetKind: typeof forecast.result.datasetKind === "string" ? forecast.result.datasetKind : null,
    totals: { d7: new SimulationDecimal(d7).toFixed(2), d14: new SimulationDecimal(d14).toFixed(2), d28: new SimulationDecimal(d28).toFixed(2) },
  };
}

async function transactionToday(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ today: string; at: Date }>>`
    SELECT ((at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::text AS "today", at
    FROM (SELECT clock_timestamp() AS at) AS clock
  `;
  if (!rows[0]) throw new Error("Không thể đọc thời điểm mô phỏng.");
  return rows[0];
}

export async function searchSimulationVariants(businessId: string, query: Record<string, unknown>) {
  const search = query.search === undefined ? "" : query.search;
  if (typeof search !== "string" || search.length > 100) throw new HttpError(400, "Tìm kiếm không hợp lệ.");
  const positiveInt = (value: unknown, fallback: number, max: number, name: string) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw new HttpError(400, `${name} không hợp lệ.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > max) throw new HttpError(400, `${name} không hợp lệ.`);
    return parsed;
  };
  const page = positiveInt(query.page, 1, 100000, "Trang");
  const pageSize = positiveInt(query.pageSize, 25, 50, "Số dòng mỗi trang");
  const rows = await prisma.productVariant.findMany({
    where: { businessId, template: { businessId }, ...(search.trim() ? { OR: [
      { sku: { contains: search.trim(), mode: "insensitive" } },
      { template: { name: { contains: search.trim(), mode: "insensitive" } } },
    ] } : {}) },
    select: { id: true, sku: true, isActive: true, template: { select: { name: true } } },
    orderBy: [{ sku: "asc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize + 1,
  });
  return { items: rows.slice(0, pageSize).map((row) => ({ id: row.id, sku: row.sku, name: row.template.name, isActive: row.isActive })), page, pageSize, hasMore: rows.length > pageSize };
}

export async function getSimulationBasis(businessId: string, query: Record<string, unknown>) {
  const id = variantId(query.variantId);
  return prisma.$transaction(async (tx) => {
    const { today, at } = await transactionToday(tx);
    const [variant, latest, forecast] = await Promise.all([
      tx.productVariant.findFirst({ where: { id, businessId, template: { businessId } }, select: {
        id: true, sku: true, basePrice: true, costPrice: true, isActive: true, template: { select: { name: true } },
      } }),
      tx.aiInsightRun.findFirst({ where: { businessId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        select: { id: true, status: true, dataAsOf: true, finishedAt: true, summary: true } }),
      tx.aiForecast.findUnique({ where: { businessId_variantId: { businessId, variantId: id } },
        select: { runId: true, asOf: true, status: true, model: true, confidence: true, result: true, updatedAt: true } }),
    ]);
    if (!variant) throw new HttpError(404, "Không tìm thấy SKU trong cửa hàng.");
    return {
      variant: { id: variant.id, sku: variant.sku, name: variant.template.name, isActive: variant.isActive,
        basePrice: variant.basePrice.toFixed(2), costPrice: variant.costPrice.toFixed(2) },
      today, asOf: at, forecast: simulationForecast(today, latest, forecast),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function simulateProfit(businessId: string, body: unknown) {
  if (!isObject(body)) throw new HttpError(400, "Yêu cầu mô phỏng không hợp lệ.");
  const id = variantId(body.variantId);
  const days = horizon(body.days);
  const result = calculateComparison(body.baseline, body.scenario);
  return prisma.$transaction(async (tx) => {
    const { today, at } = await transactionToday(tx);
    const variant = await tx.productVariant.findFirst({
      where: { id, businessId, template: { businessId } }, select: { id: true, sku: true, template: { select: { name: true } } },
    });
    if (!variant) throw new HttpError(404, "Không tìm thấy SKU trong cửa hàng.");
    const start = addDays(today, 1);
    if (body.start !== start) throw new HttpError(400, "Kỳ mô phỏng đã thay đổi. Vui lòng tải lại thông tin SKU.");
    return { variant: { id, sku: variant.sku, name: variant.template.name }, period: { start, end: addDays(start, days - 1), days }, calculatedAt: at, ...result };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
