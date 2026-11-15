import { randomUUID } from "node:crypto";
import { HttpError } from "../../shared/http/http-error";
import { addDays } from "../ai-insights/snapshot/build-snapshot";
import type { InsightSettings, Snapshot } from "../ai-insights/types";
import type { Confidence, ForecastComparison, ForecastModelName, ForecastResult, ForecastTotals } from "./forecast";

const MODELS: ForecastModelName[] = ["MEAN_28", "SES", "CROSTON_SBA", "LIGHTGBM"];
const fail = (): never => { throw new HttpError(502, "Dịch vụ dự báo trả dữ liệu không hợp lệ."); };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const nonnegative = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail();
const nullableNumber = (value: unknown, positive = false): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value < 0)) return fail();
  return value;
};
const totals = (value: unknown): ForecastTotals => {
  const row = object(value);
  const result = { d7: nonnegative(row.d7), d14: nonnegative(row.d14), d28: nonnegative(row.d28) };
  if (result.d7 > result.d14 || result.d14 > result.d28) return fail();
  return result;
};

function endpoint() {
  const raw = process.env.FORECAST_RESEARCH_URL;
  const token = process.env.FORECAST_RESEARCH_TOKEN;
  if (!raw || !token) throw new HttpError(503, "Dịch vụ dự báo chưa được cấu hình.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(503, "Địa chỉ dịch vụ dự báo không hợp lệ."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new HttpError(503, "Dịch vụ dự báo phải dùng địa chỉ HTTP nội bộ 127.0.0.1.");
  }
  return { url: new URL("/v1/forecasts:predict", url).toString(), token };
}

export function parseForecastResponse(value: unknown, requestId: string, asOf: string, expected: Map<string, number>, minSeriesDays = 28): Map<string, ForecastResult> {
  const body = object(value);
  if (body.request_id !== requestId || body.as_of !== asOf || body.dataset_kind !== "synthetic" || body.stock_history_policy !== "known-v1" ||
      typeof body.model_version !== "string" || !body.model_version || !Array.isArray(body.results) || body.results.length !== expected.size) return fail();
  const modelVersion = body.model_version;
  const output = new Map<string, ForecastResult>();
  for (const raw of body.results) {
    const row = object(raw);
    if (typeof row.variant_id !== "string" || !expected.has(row.variant_id) || output.has(row.variant_id) ||
        row.series_days !== expected.get(row.variant_id)) return fail();
    const seriesDays = nonnegative(row.series_days);
    if (row.status === "INSUFFICIENT_DATA") {
      if (row.reason !== "SHORT_HISTORY" && row.reason !== "CENSORED_HISTORY") return fail();
      output.set(row.variant_id, {
        status: "INSUFFICIENT_DATA", seriesDays, reason: row.reason, model: null, modelVersion, datasetKind: "synthetic",
        dailyRate: 0, dailySigma: 0, dailyRates: [], totals: { d7: 0, d14: 0, d28: 0 },
        wape: null, bias: null, confidence: null, activeShare: 0, stockoutShare: 0, comparison: [],
      });
      continue;
    }
    if (row.status !== "OK" || seriesDays < minSeriesDays || typeof row.model !== "string" || !MODELS.includes(row.model as ForecastModelName)) return fail();
    const model = row.model as ForecastModelName;
    const confidence = row.confidence;
    if (confidence !== null && confidence !== "HIGH" && confidence !== "MEDIUM" && confidence !== "LOW") return fail();
    const predicted = totals(row.totals);
    const segments = object(row.segments);
    const first = nonnegative(segments.days_1_7);
    const second = nonnegative(segments.days_8_14);
    const third = nonnegative(segments.days_15_28);
    if (Math.abs(predicted.d7 - first) > 1e-5 || Math.abs(predicted.d14 - first - second) > 1e-5 ||
        Math.abs(predicted.d28 - first - second - third) > 1e-5) return fail();
    if (!Array.isArray(row.comparison) || row.comparison.length !== MODELS.length) return fail();
    const comparison: ForecastComparison[] = row.comparison.map((entry: unknown) => {
      const score = object(entry);
      if (typeof score.model !== "string" || !MODELS.includes(score.model as ForecastModelName) ||
          !Number.isInteger(score.count) || (score.count as number) < 0 || (score.count as number) > 4) return fail();
      return {
        model: score.model as ForecastModelName, totals: totals(score.totals), count: score.count as number,
        mae: nullableNumber(score.mae, true), wape: nullableNumber(score.wape, true), bias: nullableNumber(score.bias),
      };
    });
    const chosen = comparison.find((entry) => entry.model === model);
    if (new Set(comparison.map((entry) => entry.model)).size !== MODELS.length || !chosen ||
        Math.abs(chosen.totals.d7 - predicted.d7) > 1e-5 || Math.abs(chosen.totals.d14 - predicted.d14) > 1e-5 ||
        Math.abs(chosen.totals.d28 - predicted.d28) > 1e-5) return fail();
    const activeShare = nonnegative(row.active_share);
    const stockoutShare = nonnegative(row.stockout_share);
    if (activeShare > 1 || stockoutShare > 1) return fail();
    output.set(row.variant_id, {
      status: "OK", seriesDays, reason: null, model, modelVersion, datasetKind: "synthetic",
      dailyRate: predicted.d28 / 28, dailySigma: nonnegative(row.daily_sigma),
      dailyRates: [...Array(7).fill(first / 7), ...Array(7).fill(second / 7), ...Array(14).fill(third / 14)],
      totals: predicted, wape: nullableNumber(row.wape, true), bias: nullableNumber(row.bias),
      confidence: confidence as Confidence | null, activeShare, stockoutShare, comparison,
    });
  }
  return output;
}

export async function attachForecasts(snapshot: Snapshot, settings: InsightSettings): Promise<Snapshot> {
  if (!snapshot.variants.length) return snapshot;
  const service = endpoint();
  const forecasts = new Map<string, ForecastResult>();
  for (let start = 0; start < snapshot.variants.length; start += 200) {
    const batch = snapshot.variants.slice(start, start + 200);
    const variants = batch.map((variant) => {
      if (!variant.grossDailySales) throw new HttpError(500, "Không có chuỗi số bán POS để dự báo.");
      const days = Math.min(variant.ageDays, variant.grossDailySales.length);
      const sales = days ? variant.grossDailySales.slice(-days) : [];
      if (!variant.forecastStockoutDays) throw new HttpError(500, "Không có lịch sử tồn kho đã kiểm tra để dự báo.");
      const flags = days ? variant.forecastStockoutDays.slice(-days) : [];
      if (flags.length !== days) throw new HttpError(500, "Dữ liệu tồn kho không khớp lịch sử bán.");
      return {
        variant_id: variant.variantId,
        history: sales.map((units, index) => ({ date: addDays(snapshot.asOf, index - days + 1), units_sold: units, stockout: flags[index] })),
      };
    });
    const requestId = randomUUID();
    let response: Response;
    try {
      response = await fetch(service.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forecast-Token": service.token },
        body: JSON.stringify({ request_id: requestId, as_of: snapshot.asOf, min_series_days: Math.max(28, settings.forecast.minSeriesDays), variants }),
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      });
    } catch (error) {
      console.error("Forecast service request failed.", error);
      throw new HttpError(503, "Không kết nối được dịch vụ dự báo.");
    }
    if (!response.ok) throw new HttpError(502, `Dịch vụ dự báo trả lỗi HTTP ${response.status}.`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new HttpError(502, "Dịch vụ dự báo trả JSON không hợp lệ."); }
    const parsed = parseForecastResponse(payload, requestId, snapshot.asOf, new Map(variants.map((v) => [v.variant_id, v.history.length])), Math.max(28, settings.forecast.minSeriesDays));
    for (const [id, forecast] of parsed) forecasts.set(id, forecast);
  }
  return { ...snapshot, variants: snapshot.variants.map((variant) => ({ ...variant, forecast: forecasts.get(variant.variantId)! })) };
}
