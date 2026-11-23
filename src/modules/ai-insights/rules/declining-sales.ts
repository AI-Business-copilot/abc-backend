import { SALES_WINDOW_DAYS, type Finding, type InsightSettings, type Snapshot } from "../types";

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** II04: units sold in the latest period compared with the period right before it. */
export function detectDecliningSales(snapshot: Snapshot, settings: InsightSettings): Finding[] {
  const { periodDays, minBaseUnits, mediumPct, highPct } = settings.declining;
  const findings: Finding[] = [];
  for (const v of snapshot.variants) {
    if (v.ageDays < periodDays * 2 || v.dailySales.length !== SALES_WINDOW_DAYS) continue;

    const recent = sum(v.dailySales.slice(SALES_WINDOW_DAYS - periodDays));
    const previous = sum(v.dailySales.slice(SALES_WINDOW_DAYS - periodDays * 2, SALES_WINDOW_DAYS - periodDays));
    if (previous < minBaseUnits) continue;

    const dropPct = ((previous - recent) / previous) * 100;
    if (dropPct < mediumPct) continue;

    const stockedOut = v.stockAvailable <= 0 || v.possibleStockoutBias;
    findings.push({
      type: "DECLINING_SALES",
      variantId: v.variantId,
      lotItemId: null,
      severity: dropPct >= highPct ? "HIGH" : "MEDIUM",
      reasonCode: stockedOut ? "DECLINE_POSSIBLY_STOCKOUT" : "SALES_DROP",
      suggestedAction: "INVESTIGATE",
      valueAtRisk: null,
      metrics: {
        formula: `(units in previous ${periodDays} days - units in latest ${periodDays} days) / previous`,
        periodDays,
        recentUnits: recent,
        previousUnits: previous,
        dropPct: Number(dropPct.toFixed(1)),
        stockAvailable: v.stockAvailable,
        possibleStockoutBias: v.possibleStockoutBias,
      },
    });
  }
  return findings;
}
