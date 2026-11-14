import type { Finding, InsightSettings, Snapshot } from "../types";

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/** II01: stock at or below the reorder point (average daily demand x lead time + safety stock). */
export function detectLowStock(snapshot: Snapshot, _settings: InsightSettings): Finding[] {
  const findings: Finding[] = [];
  for (const v of snapshot.variants) {
    const reorderPoint = v.avgDaily30 * v.leadTimeDays + v.safetyStockQty;
    if (!(v.avgDaily30 > 0 || v.safetyStockQty > 0)) continue;
    if (v.stockAvailable > reorderPoint) continue;

    let severity: Finding["severity"] = "MEDIUM";
    let reasonCode = "BELOW_REORDER_POINT";
    if (v.stockAvailable <= 0 && v.sold30 > 0) {
      severity = "CRITICAL";
      reasonCode = "OUT_OF_STOCK_WITH_DEMAND";
    } else if (v.stockAvailable <= v.safetyStockQty) {
      severity = "HIGH";
      reasonCode = "BELOW_SAFETY_STOCK";
    }

    findings.push({
      type: "LOW_STOCK",
      variantId: v.variantId,
      lotItemId: null,
      severity,
      reasonCode,
      suggestedAction: "REORDER",
      valueAtRisk: null,
      metrics: {
        formula: "reorderPoint = avgDaily30 x leadTimeDays + safetyStockQty",
        stockAvailable: v.stockAvailable,
        avgDaily30: round(v.avgDaily30, 3),
        leadTimeDays: v.leadTimeDays,
        safetyStockQty: v.safetyStockQty,
        reorderPoint: round(reorderPoint),
        shortfallToReorderPoint: round(reorderPoint - v.stockAvailable),
        daysOfCover: v.avgDaily30 > 0 ? round(Math.max(0, v.stockAvailable) / v.avgDaily30, 1) : null,
        sold30: v.sold30,
        possibleStockoutBias: v.possibleStockoutBias,
      },
    });
  }
  return findings;
}
