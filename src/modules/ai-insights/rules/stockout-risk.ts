import { addDays } from "../snapshot/build-snapshot";
import { arrivalsFrom, assessRisk, projectStockout } from "../../ai-forecast/stockout";
import type { Finding, InsightSettings, Severity, Snapshot } from "../types";

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/**
 * II05: products expected to run out before the next restock can arrive.
 * Uses the demand forecast, current stock and open purchase orders.
 */
export function detectStockoutRisk(snapshot: Snapshot, settings: InsightSettings): Finding[] {
  const findings: Finding[] = [];
  for (const v of snapshot.variants) {
    const forecast = v.forecast;
    if (!forecast || forecast.status !== "OK" || !(forecast.dailyRate > 0)) continue;

    const arrivals = arrivalsFrom(v.incoming ?? [], snapshot.today);
    const leadTimeDays = v.supply?.leadTimeDays ?? v.leadTimeDays;
    const stock = Math.max(0, v.stockAvailable);
    const base = assessRisk(projectStockout(stock, forecast.dailyRates, arrivals), arrivals, leadTimeDays, settings.stockout);
    const severity: Severity | null = base.level;
    const reasonCode = base.level === "CRITICAL" ? "STOCKOUT_BEFORE_RESTOCK" : "RESTOCK_WINDOW_CLOSING";
    if (!severity || base.stockoutOffset === null) continue;

    const stockoutOffset = base.stockoutOffset;
    const restockOffset = arrivals.find((a) => a.offset > stockoutOffset)?.offset ?? leadTimeDays;
    const lostUnits = base.level === "CRITICAL" ? forecast.dailyRate * base.gapDays : 0;

    findings.push({
      type: "STOCKOUT_RISK",
      variantId: v.variantId,
      lotItemId: null,
      severity,
      reasonCode,
      suggestedAction: base.level === "CRITICAL" ? (arrivals.length ? "EXPEDITE_PO" : "REORDER_NOW") : "REORDER",
      valueAtRisk: lostUnits > 0 && v.basePrice ? round(lostUnits * v.basePrice) : null,
      metrics: {
        formula: "stockoutDay = first day cumulative forecast demand exceeds stock + arrivals; risk = stockoutDay - restockDay",
        stockAvailable: stock,
        dailyRate: round(forecast.dailyRate, 3),
        model: forecast.model,
        confidence: forecast.confidence,
        wape: forecast.wape === null ? null : round(forecast.wape, 3),
        stockoutInDays: stockoutOffset,
        stockoutDate: addDays(snapshot.today, stockoutOffset),
        restockInDays: restockOffset,
        restockSource: arrivals.some((a) => a.offset > stockoutOffset) ? "OPEN_PO" : "LEAD_TIME",
        leadTimeDays,
        leadTimeSource: v.supply?.leadTimeSource ?? "VARIANT",
        slackDays: base.slackDays,
        gapDays: base.gapDays,
        incoming: v.incoming ?? [],
        lostUnits: round(lostUnits, 1),
        basePrice: v.basePrice ?? null,
        worstCaseOnly: false,
      },
    });
  }
  return findings;
}
