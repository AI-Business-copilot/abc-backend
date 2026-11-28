import { inventoryOutlook } from "../ai-insights/inventory-outlook.service";
import type { Severity } from "../ai-insights/types";

type Lot = {
  id: string;
  lotNumber: string | null;
  expirationDate: string | null;
  status: "expired" | "unsellable" | "at_risk";
  severity: Severity;
  lotQuantity: number | null;
  atRiskQty: number | null;
};

const numberOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const lotRank = { expired: 0, unsellable: 1, at_risk: 2 };
function compareLots(a: Lot, b: Lot) {
  return lotRank[a.status] - lotRank[b.status] ||
    (a.expirationDate ?? "9999-99-99").localeCompare(b.expirationDate ?? "9999-99-99") ||
    (a.lotNumber ?? "").localeCompare(b.lotNumber ?? "", "vi") || a.id.localeCompare(b.id);
}

export async function answerSlowExpiry(businessId: string) {
  const outlook = await inventoryOutlook(businessId, {}, { all: true });
  const available = outlook.state === "READY" && "ruleFresh" in outlook && outlook.ruleFresh === true;
  const warningCodes = available ? outlook.warnings?.map((warning) => warning.code) ?? null : null;
  const partial = available && (!outlook.forecastReady || warningCodes === null ||
    warningCodes.some((code) => code === "INSUFFICIENT_HISTORY" || code === "NO_SALES_DATA"));
  const items = available && outlook.items ? outlook.items.flatMap((item) => {
    const slow = item.signals.find((signal) => signal.type === "SLOW_MOVING" && signal.current);
    if (!slow) return [];
    const lots = item.signals.filter((signal) => signal.type === "EXPIRATION_RISK" && signal.current).map<Lot>((signal) => {
      const metricDate = signal.metrics.expirationDate;
      const metricLot = signal.metrics.lotNumber;
      return {
        id: signal.id, lotNumber: signal.lotNumber ?? (typeof metricLot === "string" ? metricLot : null),
        expirationDate: signal.expirationDate ?? (typeof metricDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(metricDate) ? metricDate : null),
        status: signal.reasonCode === "EXPIRED_IN_STOCK" ? "expired" : signal.reasonCode === "UNSELLABLE_NEAR_EXPIRY" ? "unsellable" : "at_risk",
        severity: signal.severity, lotQuantity: numberOrNull(signal.metrics.lotQuantity),
        atRiskQty: numberOrNull(signal.metrics.atRiskQty),
      };
    }).sort(compareLots);
    if (!lots.length) return [];
    return [{
      variantId: item.variantId, sku: item.sku, product: item.productName,
      sold30: numberOrNull(slow.metrics.sold30), daysWithoutSale: numberOrNull(slow.metrics.daysWithoutSale),
      neverSold: typeof slow.metrics.neverSold === "boolean" ? slow.metrics.neverSold : null,
      stockAvailable: numberOrNull(slow.metrics.stockAvailable),
      totalLots: lots.length, lots: lots.slice(0, 5),
    }];
  }).sort((a, b) => compareLots(a.lots[0], b.lots[0]) ||
    a.product.localeCompare(b.product, "vi") || a.sku.localeCompare(b.sku, "vi") || a.variantId.localeCompare(b.variantId)) : [];
  const state = !available ? "unavailable" : partial ? "partial" : "ready";
  const evidence = {
    type: "slow_expiry_v1" as const, state,
    dataAsOf: outlook.latestRun?.dataAsOf ?? null,
    finishedAt: outlook.latestRun?.finishedAt?.toISOString() ?? null,
    warningCodes,
    totalSku: available ? items.length : null,
    items: items.slice(0, 10),
  };
  const text = !available
    ? "Chưa có phân tích tồn kho đủ mới để đối chiếu. Hãy xem lại lần phân tích tồn kho."
    : items.length
      ? `Có ${items.length} mã hàng vừa có cảnh báo bán chậm vừa có cảnh báo nguy cơ hết hạn trong dữ liệu hiện có.`
      : "Chưa tìm thấy mã hàng có đồng thời hai cảnh báo trong dữ liệu hiện có.";
  return { text, evidence };
}
