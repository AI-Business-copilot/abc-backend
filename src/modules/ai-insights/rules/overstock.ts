import type { Finding, InsightSettings, Snapshot } from "../types";

/** II07: stock that would take longer than the threshold to sell at the current pace. */
export function detectOverstock(snapshot: Snapshot, settings: InsightSettings): Finding[] {
  const { thresholdDays, targetDays } = settings.overstock;
  const findings: Finding[] = [];
  for (const v of snapshot.variants) {
    // Products with no sales belong to the slow-moving rule.
    if (v.stockAvailable <= 0 || !(v.avgDaily30 > 0)) continue;

    const daysOfCover = v.stockAvailable / v.avgDaily30;
    if (daysOfCover <= thresholdDays) continue;

    const excessQty = Math.max(0, Math.floor(v.stockAvailable - v.avgDaily30 * targetDays));
    findings.push({
      type: "OVERSTOCK",
      variantId: v.variantId,
      lotItemId: null,
      severity: daysOfCover > 120 ? "HIGH" : daysOfCover > 90 ? "MEDIUM" : "LOW",
      reasonCode: "EXCESS_DAYS_OF_COVER",
      suggestedAction: daysOfCover > 120 ? "CLEARANCE" : "STOP_REORDER",
      valueAtRisk: Math.round(excessQty * v.costPrice * 100) / 100,
      metrics: {
        formula: `daysOfCover = stockAvailable / avgDaily30; excessQty = stockAvailable - avgDaily30 x ${targetDays}`,
        stockAvailable: v.stockAvailable,
        avgDaily30: Number(v.avgDaily30.toFixed(3)),
        daysOfCover: Number(daysOfCover.toFixed(1)),
        thresholdDays,
        targetDays,
        excessQty,
        costPrice: v.costPrice,
        possibleStockoutBias: v.possibleStockoutBias,
      },
    });
  }
  return findings;
}
