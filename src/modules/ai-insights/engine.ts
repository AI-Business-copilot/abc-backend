import { suggestReplenishment, type ReplenishmentSuggestion } from "../ai-forecast/replenishment";
import { buildInventoryCapitalSummary } from "./rules/inventory-capital";
import { detectStockoutRisk } from "./rules/stockout-risk";
import { detectDecliningSales } from "./rules/declining-sales";
import { detectExpirationRisk } from "./rules/expiration-risk";
import { detectLowStock } from "./rules/low-stock";
import { detectOverstock } from "./rules/overstock";
import { detectSlowMoving } from "./rules/slow-moving";
import type { Finding, InsightSettings, InsightStatus, Severity, Snapshot } from "./types";

const SEVERITY_WEIGHT: Record<Severity, number> = { CRITICAL: 100, HIGH: 70, MEDIUM: 40, LOW: 10 };
const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

export interface ScoredFinding extends Finding {
  fingerprint: string;
  priorityScore: number;
}

export interface AnalysisResult {
  findings: ScoredFinding[];
  replenishment: ReplenishmentSuggestion[];
  capital: ReturnType<typeof buildInventoryCapitalSummary>;
  warnings: Array<{ code: string; message: string; count?: number }>;
  variantsAnalyzed: number;
}

export const fingerprintOf = (finding: Pick<Finding, "type" | "variantId" | "lotItemId">) =>
  `${finding.type}:${finding.variantId}:${finding.lotItemId ?? ""}`;

/** Severity weight plus up to 30 points for the share of the largest value at risk. */
export function scoreFindings(findings: Finding[]): ScoredFinding[] {
  const maxValue = Math.max(0, ...findings.map((f) => f.valueAtRisk ?? 0));
  return findings.map((finding) => ({
    ...finding,
    fingerprint: fingerprintOf(finding),
    priorityScore: Math.round(
      SEVERITY_WEIGHT[finding.severity] +
        (maxValue > 0 && finding.valueAtRisk ? Math.min(30, (finding.valueAtRisk / maxValue) * 30) : 0),
    ),
  }));
}

/** A stockout-risk row replaces the low-stock row of the same product and keeps the worse severity. */
export function mergeStockoutWithLowStock(stockout: Finding[], lowStock: Finding[]) {
  const lowByVariant = new Map(lowStock.map((f) => [f.variantId, f]));
  const merged = stockout.map((f) => {
    const low = lowByVariant.get(f.variantId);
    if (!low || SEVERITY_RANK[low.severity] <= SEVERITY_RANK[f.severity]) return f;
    return { ...f, severity: low.severity };
  });
  const covered = new Set(stockout.map((f) => f.variantId));
  return { stockout: merged, lowStock: lowStock.filter((f) => !covered.has(f.variantId)) };
}

/** Pure analysis step: no database access. Demand-based rules skip products that are too new to judge. */
export function analyze(snapshot: Snapshot, settings: InsightSettings): AnalysisResult {
  const mature = { ...snapshot, variants: snapshot.variants.filter((v) => v.ageDays >= settings.minHistoryDays) };
  const immature = snapshot.variants.length - mature.variants.length;

  const lowStock = detectLowStock(mature, settings);
  const stockout = detectStockoutRisk(mature, settings);
  const merged = mergeStockoutWithLowStock(stockout, lowStock);

  const demandFindings = [
    ...merged.lowStock,
    ...merged.stockout,
    ...detectSlowMoving(mature, settings),
    ...detectDecliningSales(mature, settings),
    ...detectOverstock(mature, settings),
  ];
  const findings = scoreFindings([...demandFindings, ...detectExpirationRisk(snapshot, settings)]);

  const replenishment = snapshot.variants
    .map((v) => suggestReplenishment(v, snapshot.today, settings))
    .filter((s): s is ReplenishmentSuggestion => s !== null);

  const warnings: AnalysisResult["warnings"] = [];
  const shortHistory = snapshot.variants.filter((v) => v.forecast?.reason === "SHORT_HISTORY").length;
  if (shortHistory > 0) {
    warnings.push({
      code: "FORECAST_INSUFFICIENT_DATA",
      message: `${shortHistory} sản phẩm có dưới ${Math.max(28, settings.forecast.minSeriesDays)} ngày dữ liệu nên chưa dự báo được nhu cầu.`,
      count: shortHistory,
    });
  }
  const censored = snapshot.variants.filter((v) => v.forecast?.reason === "CENSORED_HISTORY").length;
  if (censored) warnings.push({ code: "FORECAST_CENSORED_HISTORY", message: `${censored} sản phẩm có quá ít ngày còn hàng để dự báo.`, count: censored });
  const longLead = snapshot.variants.filter((v) => v.forecast?.status === "OK" && v.supply &&
    v.supply.leadTimeDays + v.supply.reviewPeriodDays > v.forecast.dailyRates.length).length;
  if (longLead) warnings.push({
    code: "FORECAST_HORIZON_TOO_SHORT",
    message: `${longLead} sản phẩm có thời gian giao và chu kỳ đặt hàng vượt 28 ngày nên chưa được gợi ý nhập.`,
    count: longLead,
  });
  const syntheticModels = snapshot.variants.filter((v) => v.forecast?.status === "OK" && v.forecast.model === "LIGHTGBM").length;
  if (syntheticModels) warnings.push({
    code: "FORECAST_SYNTHETIC_MODEL",
    message: `${syntheticModels} sản phẩm dùng mô hình huấn luyện trên dữ liệu giả lập; cần kiểm tra gợi ý trước khi đặt hàng.`,
    count: syntheticModels,
  });
  if (immature > 0) {
    warnings.push({
      code: "INSUFFICIENT_HISTORY",
      message: `${immature} sản phẩm có dưới ${settings.minHistoryDays} ngày dữ liệu nên chưa được đánh giá nhu cầu.`,
      count: immature,
    });
  }
  const biased = mature.variants.filter((v) => v.possibleStockoutBias).length;
  if (biased > 0) {
    warnings.push({
      code: "POSSIBLE_STOCKOUT_BIAS",
      message: `${biased} sản phẩm từng hết hàng trong 30 ngày qua nên nhu cầu trung bình có thể bị đánh giá thấp.`,
      count: biased,
    });
  }
  if (!snapshot.variants.some((v) => v.sold60 > 0)) {
    warnings.push({ code: "NO_SALES_DATA", message: "Chưa có dữ liệu bán hàng POS trong 60 ngày gần nhất." });
  }

  return {
    findings,
    replenishment,
    capital: buildInventoryCapitalSummary(mature, findings),
    warnings,
    variantsAnalyzed: mature.variants.length,
  };
}

export interface ExistingInsight {
  status: string;
  severity: string;
  snoozeUntil: Date | string | null;
}

/**
 * Decides the status of an insight that is detected again.
 * Handled insights stay handled until their snooze ends or the severity gets worse.
 */
export function nextStatus(existing: ExistingInsight, severity: Severity, today: string): InsightStatus {
  const current = existing.status as InsightStatus;
  const escalated = SEVERITY_RANK[severity] > (SEVERITY_RANK[existing.severity as Severity] ?? 0);
  if (current === "OPEN") return "OPEN";
  if (current === "RESOLVED") return "OPEN";
  if (escalated) return "OPEN";
  if (current === "DISMISSED") {
    const until = existing.snoozeUntil ? new Date(existing.snoozeUntil).toISOString().slice(0, 10) : null;
    return until !== null && until <= today ? "OPEN" : "DISMISSED";
  }
  return current;
}
