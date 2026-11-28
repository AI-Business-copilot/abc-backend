import { getProductPerformance } from "../business-data/product-performance.service";
import { inventoryOutlook } from "../ai-insights/inventory-outlook.service";
import { HttpError } from "../../shared/http/http-error";
import { completedDaysRange } from "../../shared/dates/date-range";

type RankedSku = { variantId: string; sku: string; product: string; unitsSold: number };
export type RankingEvidence = {
  type: "top_sellers_v1";
  period: { from: string; to: string };
  salesAsOf: string;
  warnings: { excludedSaleItems: number; excludedReturnItems: number; missingReturnCostLinks: number };
  items: RankedSku[];
};
type StockoutEvidence = {
  type: "sku_stockout_v1";
  period: RankingEvidence["period"];
  salesAsOf: string;
  warnings: RankingEvidence["warnings"];
  items: Array<RankedSku & { severity: "HIGH" | "CRITICAL"; stockoutDate: string | null }>;
  rankingCount: number;
  riskState: "ready" | "unavailable";
  riskDataAsOf: string | null;
  riskFinishedAt: string | null;
};

function isRankedSku(value: unknown): value is RankedSku {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.variantId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.variantId) &&
    typeof item.sku === "string" && typeof item.product === "string" &&
    typeof item.unitsSold === "number" && Number.isSafeInteger(item.unitsSold) && item.unitsSold > 0;
}

export function previousRanking(value: unknown): RankingEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Hãy xem danh sách bán chạy trước khi hỏi 'trong số đó'.");
  }
  const data = value as Record<string, unknown>;
  const period = data.period;
  const warnings = data.warnings;
  const items = data.items;
  if (data.type !== "top_sellers_v1" || !period || typeof period !== "object" || Array.isArray(period) ||
      !("from" in period) || !("to" in period) || typeof period.from !== "string" || typeof period.to !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(period.from) || !/^\d{4}-\d{2}-\d{2}$/.test(period.to) ||
      typeof data.salesAsOf !== "string" || Number.isNaN(Date.parse(data.salesAsOf)) ||
      !warnings || typeof warnings !== "object" || Array.isArray(warnings) ||
      !("excludedSaleItems" in warnings) || !("excludedReturnItems" in warnings) || !("missingReturnCostLinks" in warnings) ||
      typeof warnings.excludedSaleItems !== "number" || typeof warnings.excludedReturnItems !== "number" || typeof warnings.missingReturnCostLinks !== "number" ||
      !Array.isArray(items) || items.length > 5 || !items.every(isRankedSku)) {
    throw new HttpError(400, "Không có danh sách bán chạy phù hợp để đối chiếu; hãy tạo lại danh sách.");
  }
  return {
    type: "top_sellers_v1", period: { from: period.from, to: period.to }, salesAsOf: data.salesAsOf,
    warnings: { excludedSaleItems: warnings.excludedSaleItems, excludedReturnItems: warnings.excludedReturnItems, missingReturnCostLinks: warnings.missingReturnCostLinks },
    items: items.map((item) => ({ variantId: item.variantId, sku: item.sku, product: item.product, unitsSold: item.unitsSold })),
  };
}

export async function rankTopSellers(businessId: string, period = completedDaysRange(7)): Promise<RankingEvidence> {
  const { from, to } = period;
  const result = await getProductPerformance(businessId, { from, to, all: "true" });
  const items = result.items.flatMap((product) => product.variants.map((variant) => ({
    variantId: variant.id, sku: variant.sku, product: product.name, unitsSold: variant.current.unitsSold,
  }))).filter((item) => item.unitsSold > 0).sort((a, b) =>
    b.unitsSold - a.unitsSold || a.product.localeCompare(b.product, "vi") || a.sku.localeCompare(b.sku, "vi") || a.variantId.localeCompare(b.variantId),
  ).slice(0, 5);
  return { type: "top_sellers_v1", period: { from, to }, salesAsOf: result.asOf.toISOString(), warnings: result.warnings, items };
}

export function answerTopSellerRanking(ranking: RankingEvidence) {
  return { text: ranking.items.length ? "Các mã hàng bán nhiều nhất trong 7 ngày hoàn chỉnh gần nhất." : "Không có mã hàng nào ghi nhận bán trong kỳ.", evidence: ranking };
}

export async function answerRankedStockout(businessId: string, ranking: RankingEvidence) {
  const outlook = await inventoryOutlook(businessId, { pageSize: "100" }, { variantIds: ranking.items.map((item) => item.variantId) });
  const ready = outlook.state === "READY" && "ruleFresh" in outlook && outlook.ruleFresh === true && outlook.forecastReady === true;
  const entries: StockoutEvidence["items"] = [];
  if (ready && outlook.items) {
    for (const item of ranking.items) {
      const source = outlook.items.find((candidate) => candidate.variantId === item.variantId);
      const signals = source?.signals.filter((candidate) => candidate.type === "STOCKOUT_RISK" && candidate.current &&
        (candidate.severity === "HIGH" || candidate.severity === "CRITICAL")) ?? [];
      const signal = signals.find((candidate) => candidate.severity === "CRITICAL") ?? signals[0];
      if (signal && (signal.severity === "HIGH" || signal.severity === "CRITICAL")) {
        const date = signal.metrics.stockoutDate;
        entries.push({ ...item, severity: signal.severity, stockoutDate: typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null });
      }
    }
  }
  const evidence: StockoutEvidence = {
    type: "sku_stockout_v1", period: ranking.period, salesAsOf: ranking.salesAsOf, warnings: ranking.warnings,
    items: entries, rankingCount: ranking.items.length, riskState: ready ? "ready" : "unavailable",
    riskDataAsOf: outlook.latestRun?.dataAsOf ?? null,
    riskFinishedAt: outlook.latestRun?.finishedAt?.toISOString() ?? null,
  };
  const text = !ranking.items.length ? "Không có mã hàng nào ghi nhận bán trong kỳ để đối chiếu nguy cơ hết hàng." :
    !ready ? "Chưa đủ dữ liệu dự báo mới để đối chiếu nguy cơ hết hàng. Hãy xem lại lần phân tích tồn kho." :
    entries.length ? "Trong các mã hàng bán chạy, những mã sau có cảnh báo hết hàng cao hoặc khẩn cấp." :
      "Chưa có cảnh báo hết hàng cao hoặc khẩn cấp cho các mã hàng này. Điều đó không chứng minh chúng an toàn.";
  return { text, evidence };
}

export async function answerSkuQuestion(businessId: string, kind: "top_sellers" | "top_sellers_stockout" | "previous_stockout", previous: unknown) {
  const ranking = kind === "previous_stockout" ? previousRanking(previous) : await rankTopSellers(businessId);
  return kind === "top_sellers" ? answerTopSellerRanking(ranking) : answerRankedStockout(businessId, ranking);
}

export function hasRanking(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    "type" in value && value.type === "top_sellers_v1";
}
