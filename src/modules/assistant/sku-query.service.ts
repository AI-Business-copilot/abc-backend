import { completedDaysRange, lastCompletedWeekRange, metricDate } from "../../shared/dates/date-range";
import { HttpError } from "../../shared/http/http-error";
import { answerRankedStockout, answerTopSellerRanking, rankTopSellers, type RankingEvidence } from "./sku-analysis.service";
import { answerRankedTopSellerInventory } from "./top-seller-inventory.service";
import { answerRankedRestock } from "./previous-restock.service";
import { skuCompositionForConditions, skuCompositionForEvidence, type CompositionCondition, type ComposedSkuFilters, type SkuFilter } from "./sku-composition-contracts";

const composableKinds = ["top_sellers", "top_sellers_stockout", "top_sellers_overstock", "top_sellers_near_expiry", "top_sellers_restock", "top_sellers_composed"] as const;
type ComposableKind = typeof composableKinds[number];
export type SkuQuery = {
  version: 1;
  entity: "sku";
  rank: { metric: "units_sold_before_returns"; period: { from: string; to: string }; limit: 5 };
  filter: SkuFilter | null;
};

export type ComposedSkuQuery = {
  version: 2;
  entity: "sku";
  rank: SkuQuery["rank"];
  filters: ComposedSkuFilters;
};

export function isSupportedSkuComposition(value: unknown): value is [CompositionCondition, CompositionCondition] {
  return skuCompositionForConditions(value) !== undefined;
}

export function isComposableSkuKind(kind: string): kind is ComposableKind {
  return composableKinds.some((value) => value === kind);
}

function compileSkuQuery(kind: ComposableKind, filters?: unknown, period = completedDaysRange(7)): SkuQuery | ComposedSkuQuery {
  if (kind === "top_sellers_composed") {
    const composition = skuCompositionForConditions(filters);
    if (!composition) throw new Error("Unsupported composable SKU filters.");
    return {
      version: 2, entity: "sku",
      rank: { metric: "units_sold_before_returns", period, limit: 5 },
      filters: composition.queryFilters(),
    };
  }
  let filter: SkuFilter | null;
  switch (kind) {
    case "top_sellers": filter = null; break;
    case "top_sellers_stockout": filter = { condition: "stockout_risk", severities: ["HIGH", "CRITICAL"] }; break;
    case "top_sellers_overstock": filter = { condition: "overstock" }; break;
    case "top_sellers_near_expiry": filter = { condition: "near_expiry", window: "lot_warning", includeExpired: false }; break;
    case "top_sellers_restock": filter = { condition: "pending_restock" }; break;
    default: throw new Error("Unsupported composable SKU question.");
  }
  return {
    version: 1, entity: "sku",
    rank: { metric: "units_sold_before_returns", period, limit: 5 },
    filter,
  };
}

type InventoryEvidence = Awaited<ReturnType<typeof answerRankedTopSellerInventory>>["evidence"];
type ExpiryEvidence = Extract<InventoryEvidence, { type: "top_sellers_near_expiry_v1" }>;

async function applyNearExpiry<T extends RankingEvidence["items"][number]>(
  businessId: string, ranking: RankingEvidence, source: { state: string; items: T[] },
) {
  const items: Array<T & ExpiryEvidence["items"][number]> = [];
  if (source.state === "unavailable") return { expiry: null, items };
  const result = await answerRankedTopSellerInventory(businessId, "top_sellers_near_expiry",
    { ...ranking, items: source.items });
  if (result.evidence.type !== "top_sellers_near_expiry_v1") throw new Error("Unexpected expiry result.");
  const sourceById = new Map(source.items.map((item) => [item.variantId, item]));
  for (const item of result.evidence.items) {
    const previous = sourceById.get(item.variantId);
    if (!previous) throw new Error("Expiry result is outside the preceding condition set.");
    items.push({ ...previous, ...item });
  }
  return { expiry: result.evidence, items };
}

function combinedState(first: string, expiry: ExpiryEvidence | null) {
  if (first === "unavailable") return "unavailable";
  if (!expiry) throw new Error("Incomplete composed inventory result.");
  return first === "partial" || expiry.state === "partial" ? "partial" : "ready";
}

async function executeSkuQuery(businessId: string, query: SkuQuery | ComposedSkuQuery) {
  const ranking = await rankTopSellers(businessId, query.rank.period);
  if (query.version === 2) {
    if (query.filters[0].condition === "pending_restock") {
      if (query.filters[1].condition === "overstock") {
        const restock = await answerRankedRestock(businessId, ranking, true);
        const evidence = { ...restock.evidence, type: "top_sellers_restock_overstock_v1" as const, query };
        const text = evidence.state === "unavailable"
          ? "Gợi ý nhập hoặc phân tích tồn kho chưa sẵn sàng hay đã cũ; chưa thể đối chiếu các mã bán chạy."
          : evidence.items.length
            ? `Trong ${ranking.items.length} mã bán chạy, có ${evidence.items.length} mã vừa có gợi ý nhập đang chờ vừa có cảnh báo tồn nhiều.`
            : `Trong ${ranking.items.length} mã bán chạy, chưa tìm thấy mã vừa có gợi ý nhập đang chờ vừa có cảnh báo tồn nhiều.`;
        return { text, evidence };
      }
      const restock = await answerRankedRestock(businessId, ranking);
      const { expiry, items } = await applyNearExpiry(businessId, ranking, restock.evidence);
      const evidence = {
        ...restock.evidence, type: "top_sellers_restock_near_expiry_v1" as const,
        state: combinedState(restock.evidence.state, expiry),
        sourceInventoryCaution: true, totalSku: restock.evidence.state === "unavailable" ? null : items.length,
        inventoryAsOf: expiry?.inventoryAsOf ?? null,
        inventoryDay: expiry?.inventoryDay ?? null,
        items, query,
      };
      const text = evidence.state === "unavailable"
        ? "Gợi ý nhập hoặc dự báo chưa sẵn sàng hay đã cũ; chưa thể đối chiếu các mã bán chạy."
        : items.length ? `Trong ${ranking.items.length} mã bán chạy, có ${items.length} mã vừa có gợi ý nhập đang chờ vừa có lô sắp hết hạn.`
          : `Trong ${ranking.items.length} mã bán chạy, chưa tìm thấy mã vừa có gợi ý nhập đang chờ vừa có lô sắp hết hạn.`;
      return { text, evidence };
    }
    const overstock = await answerRankedTopSellerInventory(businessId, "top_sellers_overstock", ranking);
    if (overstock.evidence.type !== "top_sellers_overstock_v1") throw new Error("Unexpected overstock result.");
    const overstockEvidence = overstock.evidence;
    const { expiry: expiryEvidence, items } = await applyNearExpiry(businessId, ranking, overstockEvidence);
    const state = combinedState(overstockEvidence.state, expiryEvidence);
    const evidence = {
      type: "top_sellers_overstock_near_expiry_v1" as const, state,
      period: ranking.period, salesAsOf: ranking.salesAsOf, warnings: ranking.warnings,
      rankingCount: ranking.items.length, totalSku: state === "unavailable" ? null : items.length,
      skippedSku: overstockEvidence.skippedSku, dataAsOf: overstockEvidence.dataAsOf, finishedAt: overstockEvidence.finishedAt,
      warningCodes: overstockEvidence.warningCodes, inventoryAsOf: expiryEvidence?.inventoryAsOf ?? null,
      inventoryDay: expiryEvidence?.inventoryDay ?? null, items, query,
    };
    const text = state === "unavailable" ? "Chưa đủ thông tin tồn kho mới để kiểm tra các mã bán chạy."
      : items.length ? `Trong ${ranking.items.length} mã bán chạy, có ${items.length} mã vừa có cảnh báo tồn nhiều vừa có lô sắp đến hạn.`
      : `Trong ${ranking.items.length} mã bán chạy, chưa tìm thấy mã vừa có cảnh báo tồn nhiều vừa có lô sắp đến hạn.`;
    return { text, evidence };
  }
  const filter = query.filter;
  let result;
  if (filter === null) {
    result = answerTopSellerRanking(ranking);
  } else {
    switch (filter.condition) {
      case "stockout_risk": result = await answerRankedStockout(businessId, ranking); break;
      case "overstock": result = await answerRankedTopSellerInventory(businessId, "top_sellers_overstock", ranking); break;
      case "near_expiry": result = await answerRankedTopSellerInventory(businessId, "top_sellers_near_expiry", ranking); break;
      case "pending_restock": result = await answerRankedRestock(businessId, ranking); break;
      default: throw new Error("Unsupported composable SKU filter.");
    }
  }
  return { ...result, evidence: { ...result.evidence, query } };
}

export async function answerComposableSkuQuestion(businessId: string, kind: ComposableKind, filters?: unknown) {
  return executeSkuQuery(businessId, compileSkuQuery(kind, filters));
}

type PeriodChange = "previous_period" | "last_week";

export function isSkuPeriodChange(value: unknown): value is PeriodChange {
  return value === "previous_period" || value === "last_week";
}

function sameValue(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length && expected.every((item, index) => sameValue(value[index], item));
  if (expected && typeof expected === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const actual = value as Record<string, unknown>;
    const target = expected as Record<string, unknown>;
    return Object.keys(actual).length === Object.keys(target).length &&
      Object.keys(target).every((key) => Object.prototype.hasOwnProperty.call(actual, key) && sameValue(actual[key], target[key]));
  }
  return value === expected;
}

function previousQuery(evidence: unknown): { kind: ComposableKind; query: SkuQuery | ComposedSkuQuery } | null {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const data = evidence as Record<string, unknown>;
  if (typeof data.analysis !== "string" || !isComposableSkuKind(data.analysis) ||
      !data.query || typeof data.query !== "object" || Array.isArray(data.query) ||
      !data.period || typeof data.period !== "object" || Array.isArray(data.period)) return null;
  const period = data.period as Record<string, unknown>;
  if (typeof period.from !== "string" || typeof period.to !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(period.from) || !/^\d{4}-\d{2}-\d{2}$/.test(period.to)) return null;
  const from = metricDate(period.from);
  const to = metricDate(period.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) ||
      from.toISOString().slice(0, 10) !== period.from || to.toISOString().slice(0, 10) !== period.to ||
      to.getTime() - from.getTime() !== 6 * 86_400_000) return null;
  const composition = skuCompositionForEvidence(data.type);
  const types: Record<ComposableKind, string | undefined> = {
    top_sellers: "top_sellers_v1", top_sellers_stockout: "sku_stockout_v1",
    top_sellers_overstock: "top_sellers_overstock_v1", top_sellers_near_expiry: "top_sellers_near_expiry_v1",
    top_sellers_restock: "top_sellers_restock_v1",
    top_sellers_composed: composition?.evidenceType,
  };
  if (typeof data.type !== "string" || data.type !== types[data.analysis]) return null;
  const filters = composition?.conditions;
  const query = compileSkuQuery(data.analysis, filters, { from: period.from, to: period.to });
  return sameValue(data.query, query) ? { kind: data.analysis, query } : null;
}

export function hasPreviousSkuQuery(evidence: unknown) {
  return previousQuery(evidence) !== null;
}

export async function answerSkuPeriodChange(businessId: string, evidence: unknown, change: PeriodChange, now = new Date()) {
  if (!isSkuPeriodChange(change)) throw new HttpError(400, "Khoảng thời gian hỏi tiếp không được hỗ trợ.");
  const previous = previousQuery(evidence);
  if (!previous) throw new HttpError(400, "Hãy xem lại câu hỏi bán chạy có thể đổi kỳ trước khi hỏi tiếp.");
  const previousFrom = metricDate(previous.query.rank.period.from);
  const previousTo = metricDate(previous.query.rank.period.to);
  previousFrom.setUTCDate(previousFrom.getUTCDate() - 7);
  previousTo.setUTCDate(previousTo.getUTCDate() - 7);
  const period = change === "last_week" ? lastCompletedWeekRange(now) :
    { from: previousFrom.toISOString().slice(0, 10), to: previousTo.toISOString().slice(0, 10) };
  const query = { ...previous.query, rank: { ...previous.query.rank, period } };
  const result = await executeSkuQuery(businessId, query);
  const text = previous.kind === "top_sellers" && result.evidence.items.length
    ? `Các mã hàng bán nhiều nhất từ ${period.from} đến ${period.to}.` : result.text;
  return { ...result, text, kind: previous.kind };
}

export function useComposableSkuQueries() {
  const value = process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED;
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new Error("ASSISTANT_COMPOSABLE_SKU_ENABLED must be true or false.");
}
