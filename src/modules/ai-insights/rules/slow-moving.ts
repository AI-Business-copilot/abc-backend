import type { Finding, InsightSettings, Snapshot } from "../types";

/** II02: products in stock that barely sell. Days without sale are counted over the whole sales history. */
export function detectSlowMoving(snapshot: Snapshot, settings: InsightSettings): Finding[] {
  const { noSaleDays, maxUnitsInWindow } = settings.slowMoving;
  const findings: Finding[] = [];
  for (const v of snapshot.variants) {
    if (v.stockAvailable <= 0 || v.ageDays < noSaleDays) continue;

    const daysWithoutSale = v.daysSinceLastSale ?? v.ageDays;
    if (!(daysWithoutSale >= noSaleDays || v.sold30 <= maxUnitsInWindow)) continue;

    const severity = daysWithoutSale >= 90 ? "HIGH" : daysWithoutSale >= 60 ? "MEDIUM" : "LOW";
    findings.push({
      type: "SLOW_MOVING",
      variantId: v.variantId,
      lotItemId: null,
      severity,
      reasonCode: v.sold30 === 0 ? "NO_SALES" : "LOW_SALES",
      suggestedAction: severity === "LOW" ? "INVESTIGATE" : "CLEARANCE",
      valueAtRisk: Math.round(v.stockAvailable * v.costPrice * 100) / 100,
      metrics: {
        formula: `no sale for >= ${noSaleDays} days, or sold30 <= ${maxUnitsInWindow}`,
        stockAvailable: v.stockAvailable,
        costPrice: v.costPrice,
        sold30: v.sold30,
        sold60: v.sold60,
        daysWithoutSale,
        neverSold: v.daysSinceLastSale === null,
        ageDays: v.ageDays,
      },
    });
  }
  return findings;
}
