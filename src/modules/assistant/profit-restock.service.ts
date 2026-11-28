import { Prisma } from "@prisma/client";
import { completedDaysRange } from "../../shared/dates/date-range";
import { inventoryOutlook } from "../ai-insights/inventory-outlook.service";
import { getProductPerformance } from "../business-data/product-performance.service";

const incompleteCodes = new Set([
  "INSUFFICIENT_HISTORY", "NO_SALES_DATA", "FORECAST_INSUFFICIENT_DATA",
  "FORECAST_CENSORED_HISTORY", "FORECAST_HORIZON_TOO_SHORT",
]);

export async function answerProfitRestock(businessId: string) {
  const period = completedDaysRange(30);
  const [performance, outlook] = await Promise.all([
    getProductPerformance(businessId, { ...period, all: "true" }),
    inventoryOutlook(businessId, {}, { all: true }),
  ]);
  const available = outlook.state === "READY" && "ruleFresh" in outlook && outlook.ruleFresh === true && outlook.forecastReady === true;
  if (available && !outlook.items) throw new Error("Inventory outlook is missing current items.");
  const warningCodes = "warnings" in outlook ? outlook.warnings?.map((warning) => warning.code) ?? null : null;
  const warnings = performance.warnings;
  const partial = available && (warningCodes === null || warningCodes.some((code) => incompleteCodes.has(code)) ||
    warnings.excludedSaleItems > 0 || warnings.excludedReturnItems > 0 || warnings.missingReturnCostLinks > 0);
  const suggestions = new Map((available && outlook.items ? outlook.items : [])
    .filter((item) => item.replenishment?.status === "PENDING" && item.replenishment.current)
    .map((item) => [item.variantId, item.replenishment]));
  const items = available ? performance.items.flatMap((product) => product.variants.flatMap((variant) => {
    const suggestion = suggestions.get(variant.id);
    if (!suggestion || !new Prisma.Decimal(variant.current.grossProfit).gt(0)) return [];
    return [{
      variantId: variant.id, product: product.name, sku: variant.sku, grossProfit: variant.current.grossProfit,
      suggestedQty: suggestion.suggestedQty, urgency: suggestion.urgency, supplierName: suggestion.supplierName,
      orderByDate: suggestion.orderByDate, stockoutDate: suggestion.stockoutDate,
    }];
  })).sort((a, b) => new Prisma.Decimal(b.grossProfit).comparedTo(a.grossProfit) ||
    a.product.localeCompare(b.product, "vi") || a.sku.localeCompare(b.sku, "vi") || a.variantId.localeCompare(b.variantId)) : [];
  const evidence = {
    type: "profit_restock_v1" as const, state: !available ? "unavailable" : partial ? "partial" : "ready",
    period, salesAsOf: performance.asOf.toISOString(), warnings, warningCodes,
    riskDataAsOf: outlook.latestRun?.dataAsOf ?? null,
    riskFinishedAt: outlook.latestRun?.finishedAt?.toISOString() ?? null,
    totalSku: available ? items.length : null, items: items.slice(0, 5),
  };
  const text = !available
    ? "Gợi ý nhập hàng chưa đủ mới hoặc dự báo chưa sẵn sàng; chưa thể đối chiếu."
    : items.length
      ? `Có ${items.length} mã có lợi nhuận gộp dương và gợi ý nhập đang chờ trong dữ liệu hiện có.`
      : "Chưa tìm thấy mã có lợi nhuận gộp dương và gợi ý nhập đang chờ trong dữ liệu hiện có.";
  return { text, evidence };
}
