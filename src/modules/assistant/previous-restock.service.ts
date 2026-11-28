import { HttpError } from "../../shared/http/http-error";
import { inventoryOutlook } from "../ai-insights/inventory-outlook.service";
import { SEVERITIES } from "../ai-insights/types";
import type { RankingEvidence } from "./sku-analysis.service";
import { skuCompositionForEvidence } from "./sku-composition-contracts";

type PreviousSku = { variantId: string; sku: string; product: string };
type PreviousList = { items: PreviousSku[]; partial: boolean; truncated: boolean; inventoryCaution: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const types = new Set(["top_sellers_v1", "sku_stockout_v1", "sku_sales_comparison_v1", "top_sellers_overstock_v1", "top_sellers_near_expiry_v1", "top_sellers_restock_v1", "slow_expiry_v1", "profit_restock_v1", "overstock_forecast_v1", "previous_restock_v1", "previous_near_expiry_v1", "previous_overstock_v1"]);
const incompleteCodes = new Set(["INSUFFICIENT_HISTORY", "NO_SALES_DATA", "FORECAST_INSUFFICIENT_DATA", "FORECAST_CENSORED_HISTORY", "FORECAST_HORIZON_TOO_SHORT"]);

export function previousList(value: unknown): PreviousList | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.type !== "string" || (!types.has(data.type) && !skuCompositionForEvidence(data.type)) || !Array.isArray(data.items)) return null;
  if (data.type === "sku_stockout_v1" && data.riskState !== "ready") return null;
  const rankingList = data.type === "top_sellers_v1" || data.type === "sku_stockout_v1" || data.type === "sku_sales_comparison_v1";
  if (!rankingList && data.state !== "ready" && data.state !== "partial") return null;
  const max = rankingList || data.type === "profit_restock_v1" || data.type === "top_sellers_restock_v1" || skuCompositionForEvidence(data.type) ? 5 : 10;
  if (!data.items.length || data.items.length > max) return null;
  const items: PreviousSku[] = [];
  for (const item of data.items) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        typeof item.variantId !== "string" || !uuid.test(item.variantId) ||
        typeof item.sku !== "string" || !item.sku || typeof item.product !== "string" || !item.product) return null;
    items.push({ variantId: item.variantId, sku: item.sku, product: item.product });
  }
  if (new Set(items.map((item) => item.variantId.toLowerCase())).size !== items.length) return null;
  if (!rankingList &&
      (typeof data.totalSku !== "number" || !Number.isSafeInteger(data.totalSku) || data.totalSku < items.length)) return null;
  const warnings = data.warnings;
  const salesPartial = !!warnings && typeof warnings === "object" && !Array.isArray(warnings) &&
    Object.entries(warnings).some(([key, count]) =>
      ["excludedSaleItems", "excludedReturnItems", "missingReturnCostLinks"].includes(key) && typeof count === "number" && count > 0);
  const missingSalesWarnings = rankingList &&
    (!warnings || typeof warnings !== "object" || Array.isArray(warnings) ||
      !["excludedSaleItems", "excludedReturnItems", "missingReturnCostLinks"].every((key) =>
        Object.entries(warnings).some(([name, count]) => name === key && typeof count === "number" && Number.isSafeInteger(count) && count >= 0)));
  const sourceWarnings = data.sourceWarnings;
  const incompleteComparison = data.type === "sku_sales_comparison_v1" &&
    (!sourceWarnings || typeof sourceWarnings !== "object" || Array.isArray(sourceWarnings) ||
      !["excludedSaleItems", "excludedReturnItems", "missingReturnCostLinks"].every((key) =>
        Object.entries(sourceWarnings).some(([name, count]) => name === key && typeof count === "number" && Number.isSafeInteger(count) && count === 0)) ||
      data.items.some((item) => !Number.isSafeInteger(item.current) || !Number.isSafeInteger(item.previous) || !Number.isSafeInteger(item.difference)));
  return {
    items,
    // Stockout evidence does not record forecast-quality warnings.
    partial: data.state === "partial" || data.type === "sku_stockout_v1" || salesPartial || missingSalesWarnings || incompleteComparison,
    truncated: (typeof data.totalSku === "number" && data.totalSku > items.length) || data.sourceTruncated === true,
    inventoryCaution: data.type === "slow_expiry_v1" || data.type === "overstock_forecast_v1" || data.type === "top_sellers_overstock_v1" || data.type === "top_sellers_near_expiry_v1" || data.type === "top_sellers_overstock_near_expiry_v1" || data.type === "previous_near_expiry_v1" || data.type === "previous_overstock_v1" || data.sourceInventoryCaution === true,
  };
}

export function hasPreviousSkuList(value: unknown) {
  return previousList(value) !== null;
}

export async function answerPreviousRestock(businessId: string, previous: unknown) {
  const list = previousList(previous);
  if (!list) throw new HttpError(400, "Hãy xem lại một danh sách mã hàng trước khi hỏi tiếp.");
  return answerRestockForList(businessId, list);
}

export async function answerPreviousOverstock(businessId: string, previous: unknown) {
  const list = previousList(previous);
  if (!list) throw new HttpError(400, "Hãy xem lại một danh sách mã hàng trước khi hỏi tiếp.");
  const outlook = await inventoryOutlook(businessId, {}, { variantIds: list.items.map((item) => item.variantId), all: true });
  const available = outlook.state === "READY" && "ruleFresh" in outlook && outlook.ruleFresh === true;
  if (available && !outlook.items) throw new Error("Inventory outlook is missing current items.");
  const warningCodes = "warnings" in outlook ? outlook.warnings?.map((warning) => warning.code) ?? null : null;
  let skippedSku = 0;
  const byVariant = new Map((available && outlook.items ? outlook.items : []).map((item) => [item.variantId, item]));
  const items = available ? list.items.flatMap((item) => {
    const source = byVariant.get(item.variantId);
    if (!source) return [];
    const signal = source.signals.find((candidate) => candidate.current && candidate.type === "OVERSTOCK");
    if (!signal) return [];
    const { stockAvailable, daysOfCover, thresholdDays } = signal.metrics;
    if (typeof stockAvailable !== "number" || typeof daysOfCover !== "number" || typeof thresholdDays !== "number") {
      skippedSku++;
      return [];
    }
    return [{
      ...item, severity: signal.severity, stockAvailable, daysOfCover, thresholdDays,
      possibleStockoutBias: signal.metrics.possibleStockoutBias === true,
    }];
  }) : [];
  const partial = available && (list.partial || skippedSku > 0 || warningCodes === null ||
    warningCodes.some((code) => code === "INSUFFICIENT_HISTORY" || code === "NO_SALES_DATA"));
  const evidence = {
    type: "previous_overstock_v1" as const, state: !available ? "unavailable" as const : partial ? "partial" as const : "ready" as const,
    sourceCount: list.items.length, sourcePartial: list.partial, sourceTruncated: list.truncated,
    sourceInventoryCaution: true, dataAsOf: outlook.latestRun?.dataAsOf ?? null,
    finishedAt: outlook.latestRun?.finishedAt?.toISOString() ?? null, warningCodes,
    skippedSku: available ? skippedSku : null, totalSku: available ? items.length : null, items,
  };
  const text = !available
    ? "Phân tích tồn kho chưa sẵn sàng hoặc đã cũ; chưa thể đối chiếu danh sách vừa xem."
    : items.length
      ? `Trong ${list.items.length} mã vừa hiển thị, có ${items.length} mã có cảnh báo tồn nhiều.`
      : partial
        ? `Trong ${list.items.length} mã vừa hiển thị, chưa đủ dữ liệu để xác nhận đầy đủ mã nào có cảnh báo tồn nhiều.`
      : `Trong ${list.items.length} mã vừa hiển thị, chưa tìm thấy cảnh báo tồn nhiều hiện hành.`;
  return { text, evidence };
}

async function answerRestockForList(businessId: string, list: PreviousList, requireOverstock = false) {
  const outlook = await inventoryOutlook(businessId, {}, { variantIds: list.items.map((item) => item.variantId), all: true });
  const available = outlook.state === "READY" && "ruleFresh" in outlook && outlook.ruleFresh === true && outlook.forecastReady === true;
  if (available && !outlook.items) throw new Error("Inventory outlook is missing current items.");
  const warningCodes = "warnings" in outlook ? outlook.warnings?.map((warning) => warning.code) ?? null : null;
  let skippedSku = 0;
  const byVariant = new Map((available && outlook.items ? outlook.items : []).map((item) => [item.variantId, item]));
  const items = available ? list.items.flatMap((item, index) => {
    const source = byVariant.get(item.variantId);
    const suggestion = source?.replenishment;
    if (!source || !suggestion || suggestion.status !== "PENDING" || !suggestion.current) return [];
    const overstock = requireOverstock ? source.signals.find((signal) => signal.current && signal.type === "OVERSTOCK") : undefined;
    if (requireOverstock && !overstock) return [];
    const metrics = overstock?.metrics;
    if (requireOverstock && (!metrics || typeof metrics.stockAvailable !== "number" ||
        typeof metrics.daysOfCover !== "number" || typeof metrics.thresholdDays !== "number")) {
      skippedSku++;
      return [];
    }
    return [{
      ...item, urgency: suggestion.urgency, suggestedQty: suggestion.suggestedQty,
      orderByDate: suggestion.orderByDate, stockoutDate: suggestion.stockoutDate, supplierName: suggestion.supplierName,
      ...(requireOverstock && metrics ? { stockAvailable: metrics.stockAvailable, daysOfCover: metrics.daysOfCover,
        thresholdDays: metrics.thresholdDays, possibleStockoutBias: metrics.possibleStockoutBias === true } : {}),
      cautions: source.signals.filter((signal) => signal.current &&
        (signal.type === "OVERSTOCK" || signal.type === "EXPIRATION_RISK" || signal.type === "SLOW_MOVING"))
        .map((signal) => signal.type).filter((type, i, all) => all.indexOf(type) === i),
      previousIndex: index,
    }];
  }).sort((a, b) => SEVERITIES.indexOf(a.urgency) - SEVERITIES.indexOf(b.urgency) ||
    (a.orderByDate ?? "9999-99-99").localeCompare(b.orderByDate ?? "9999-99-99") || a.previousIndex - b.previousIndex)
    .map(({ previousIndex: _previousIndex, ...item }) => item) : [];
  const partial = available && (list.partial || skippedSku > 0 || warningCodes === null || warningCodes.some((code) => incompleteCodes.has(code)));
  const evidence = {
    type: "previous_restock_v1" as const, state: !available ? "unavailable" : partial ? "partial" : "ready",
    sourceCount: list.items.length, sourcePartial: list.partial, sourceTruncated: list.truncated, sourceInventoryCaution: list.inventoryCaution,
    dataAsOf: outlook.latestRun?.dataAsOf ?? null,
    finishedAt: outlook.latestRun?.finishedAt?.toISOString() ?? null, warningCodes,
    ...(requireOverstock ? { skippedSku: available ? skippedSku : null } : {}),
    totalSku: available ? items.length : null, items,
  };
  const text = !available
    ? "Gợi ý nhập hoặc dự báo chưa sẵn sàng hay đã cũ; chưa thể đối chiếu danh sách vừa xem."
    : items.length
      ? `Trong ${list.items.length} mã vừa hiển thị, có ${items.length} mã có gợi ý nhập đang chờ.`
      : `Trong ${list.items.length} mã vừa hiển thị, chưa tìm thấy gợi ý nhập đang chờ còn hiệu lực.`;
  return { text, evidence };
}

export async function answerRankedRestock(businessId: string, ranking: RankingEvidence, requireOverstock = false) {
  const list: PreviousList = {
    items: ranking.items, partial: Object.values(ranking.warnings).some((value) => value > 0),
    truncated: false, inventoryCaution: requireOverstock,
  };
  const result = await answerRestockForList(businessId, list, requireOverstock);
  const suggestions = new Map(result.evidence.items.map((item) => [item.variantId, item]));
  const items = ranking.items.flatMap((item) => {
    const suggestion = suggestions.get(item.variantId);
    return suggestion ? [{ ...suggestion, unitsSold: item.unitsSold }] : [];
  });
  const evidence = {
    ...result.evidence, type: "top_sellers_restock_v1" as const,
    period: ranking.period, salesAsOf: ranking.salesAsOf, warnings: ranking.warnings, items,
  };
  const text = evidence.state === "unavailable"
    ? "Gợi ý nhập hoặc dự báo chưa sẵn sàng hay đã cũ; chưa thể đối chiếu các mã bán chạy."
    : `Trong ${ranking.items.length} mã bán chạy, ${items.length ? `có ${items.length} mã có gợi ý nhập đang chờ` : "chưa tìm thấy gợi ý nhập đang chờ còn hiệu lực"}.`;
  return { text, evidence };
}
