import { Prisma } from "@prisma/client";
import { inventoryOutlook } from "../ai-insights/inventory-outlook.service";
import { addDays } from "../ai-insights/snapshot/build-snapshot";
import { nextDayForecastTotals, simulationForecast } from "../business-data/profit-simulation.service";

const incompleteCodes = new Set([
  "INSUFFICIENT_HISTORY", "NO_SALES_DATA", "FORECAST_INSUFFICIENT_DATA",
  "FORECAST_CENSORED_HISTORY", "FORECAST_HORIZON_TOO_SHORT",
]);

export async function answerOverstockForecast(businessId: string) {
  const outlook = await inventoryOutlook(businessId, {}, { all: true, includeForecastComparison: true });
  const available = outlook.state === "READY" && "ruleFresh" in outlook && outlook.ruleFresh === true && outlook.forecastReady === true;
  const context = "forecastContext" in outlook ? outlook.forecastContext : null;
  if (available && (!outlook.items || !context)) throw new Error("Inventory forecast comparison is missing current data.");
  const warningCodes = "warnings" in outlook ? outlook.warnings?.map((warning) => warning.code) ?? null : null;
  const forecasts = new Map(context?.forecasts.map((entry) => [entry.variantId, entry]) ?? []);
  const sales = new Map(context?.sales.map((entry) => [entry.variantId, entry._sum.unitsSold]) ?? []);
  let skipped = 0;
  const items = available && outlook.items && context ? outlook.items.flatMap((item) => {
    const signal = item.signals.find((entry) => entry.type === "OVERSTOCK" && entry.current);
    if (!signal) return [];
    const stock = signal.metrics.stockAvailable;
    const cover = signal.metrics.daysOfCover;
    const threshold = signal.metrics.thresholdDays;
    if (typeof stock !== "number" || stock <= 0 || typeof cover !== "number" || cover <= 0 ||
        typeof threshold !== "number" || threshold <= 0) {
      skipped++;
      return [];
    }
    const forecast = forecasts.get(item.variantId) ?? null;
    const checked = simulationForecast(context.today, context.latest, forecast);
    if (checked.status !== "READY" || !forecast) {
      skipped++;
      return [];
    }
    const totals = nextDayForecastTotals(forecast.result);
    if (!totals) throw new Error("Validated forecast is missing its next-day totals.");
    const sold30 = sales.get(item.variantId) ?? 0;
    if (!Number.isSafeInteger(sold30) || sold30 <= 0) {
      skipped++;
      return [];
    }
    const projected = new Prisma.Decimal(totals.d7);
    const baseline = new Prisma.Decimal(sold30).mul(7).div(30);
    if (projected.mul(30).gt(new Prisma.Decimal(sold30).mul(7).mul(0.9))) return [];
    return [{
      variantId: item.variantId, sku: item.sku, product: item.productName,
      severity: signal.severity, stockAvailable: stock, daysOfCover: cover, thresholdDays: threshold,
      sold30, forecast7: totals.d7,
      dropPercent: new Prisma.Decimal(1).minus(projected.div(baseline)).mul(100).toDecimalPlaces(1).toNumber(),
      possibleStockoutBias: signal.metrics.possibleStockoutBias === true,
    }];
  }).sort((a, b) => b.daysOfCover - a.daysOfCover ||
    a.product.localeCompare(b.product, "vi") || a.sku.localeCompare(b.sku, "vi") || a.variantId.localeCompare(b.variantId)) : [];
  const partial = available && (skipped > 0 || warningCodes === null || warningCodes.some((code) => incompleteCodes.has(code)));
  const dataAsOf = outlook.latestRun?.dataAsOf ?? null;
  const evidence = {
    type: "overstock_forecast_v1" as const, state: !available ? "unavailable" : partial ? "partial" : "ready",
    dataAsOf, finishedAt: outlook.latestRun?.finishedAt?.toISOString() ?? null, warningCodes,
    salesPeriod: dataAsOf ? { from: addDays(dataAsOf, -29), to: dataAsOf } : null,
    forecastPeriod: available && dataAsOf ? { from: addDays(dataAsOf, 2), to: addDays(dataAsOf, 8) } : null,
    skippedSku: available ? skipped : null, totalSku: available ? items.length : null, items: items.slice(0, 10),
  };
  const text = !available
    ? "Phân tích tồn kho hoặc dự báo chưa sẵn sàng hay đã cũ; chưa thể đối chiếu."
    : items.length
      ? `Có ${items.length} mã có cảnh báo tồn nhiều và mức bán dự báo giảm ít nhất 10% trong dữ liệu hiện có.`
      : "Chưa tìm thấy mã có cảnh báo tồn nhiều và mức bán dự báo giảm ít nhất 10% trong dữ liệu có thể đối chiếu.";
  return { text, evidence };
}
