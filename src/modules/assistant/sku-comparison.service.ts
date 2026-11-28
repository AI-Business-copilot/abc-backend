import { getProductPerformance } from "../business-data/product-performance.service";
import { vietnamToday } from "../../shared/dates/date-range";
import { HttpError } from "../../shared/http/http-error";
import { previousRanking } from "./sku-analysis.service";
import { hasPreviousSkuQuery } from "./sku-query.service";

function comparableRanking(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !("analysis" in value) || value.analysis !== "top_sellers" || !hasPreviousSkuQuery(value)) return null;
  try {
    const ranking = previousRanking(value);
    if (!ranking.items.length || new Set(ranking.items.map((item) => item.variantId)).size !== ranking.items.length ||
        ranking.items.some((item) => !item.product.trim() || !item.sku.trim()) ||
        Object.values(ranking.warnings).some((count) => !Number.isSafeInteger(count) || count < 0) ||
        ranking.period.to >= vietnamToday()) return null;
    return ranking;
  } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
}

export function hasComparableRanking(value: unknown) {
  return comparableRanking(value) !== null;
}

export async function answerSkuComparison(businessId: string, value: unknown) {
  const ranking = comparableRanking(value);
  if (!ranking) throw new HttpError(400, "Hãy xem lại danh sách bán chạy có dữ liệu trước khi so sánh số bán với kỳ liền trước.");
  const snapshot = await getProductPerformance(businessId, { ...ranking.period, all: "true" });
  const variants = new Map(snapshot.items.flatMap((product) => product.variants.map((variant) => [variant.id, variant] as const)));
  const items = ranking.items.map((item) => {
    const variant = variants.get(item.variantId);
    if (!variant) return { variantId: item.variantId, sku: item.sku, product: item.product, current: null, previous: null, difference: null };
    const current = variant.current.unitsSold;
    const previous = variant.previous.unitsSold;
    if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(previous) || previous < 0 ||
        !Number.isSafeInteger(current - previous)) throw new Error("Invalid POS units in SKU comparison.");
    return { variantId: item.variantId, sku: item.sku, product: item.product, current, previous, difference: current - previous };
  });
  const missing = items.filter((item) => item.current === null).length;
  const warnings = snapshot.warnings;
  const hasWarnings = warnings.excludedSaleItems > 0 || warnings.excludedReturnItems > 0 || warnings.missingReturnCostLinks > 0;
  const sourceWarnings = ranking.warnings;
  const hasSourceWarnings = sourceWarnings.excludedSaleItems > 0 || sourceWarnings.excludedReturnItems > 0 || sourceWarnings.missingReturnCostLinks > 0;
  const text = `So sánh số bán trước trừ hàng trả của ${items.length} mã đã hiển thị với kỳ liền trước, cùng 7 ngày; không xếp hạng lại.${missing ? ` Có ${missing} mã không còn trong dữ liệu đối chiếu, chưa thể kết luận.` : ""}${hasWarnings || hasSourceWarnings ? " Có cảnh báo dữ liệu có thể ảnh hưởng danh sách hoặc kết quả; hãy xem căn cứ." : ""} Số liệu được đọc lại và có thể khác câu trả lời trước; chênh lệch không cho biết nguyên nhân.`;
  return {
    text,
    evidence: {
      type: "sku_sales_comparison_v1" as const, items, ranges: snapshot.ranges,
      sourceSalesAsOf: ranking.salesAsOf, salesAsOf: snapshot.asOf.toISOString(), sourceWarnings, warnings,
    },
  };
}
