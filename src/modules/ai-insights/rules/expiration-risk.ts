import type { Finding, InsightSettings, Snapshot } from "../types";

const MAX_HORIZON_DAYS = 180;

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * II06: lots that will not be sold before they expire.
 * Lots are consumed first-expired-first-out, so a lot only gets the demand left over by earlier lots.
 */
export function detectExpirationRisk(snapshot: Snapshot, _settings: InsightSettings): Finding[] {
  const findings: Finding[] = [];
  for (const v of snapshot.variants) {
    const lots = v.lots
      .filter((lot) => lot.quantity > 0)
      .map((lot) => ({ ...lot, daysToExpiry: daysBetween(snapshot.today, lot.expirationDate) }))
      .sort((a, b) => a.daysToExpiry - b.daysToExpiry);

    let sellableAhead = 0;
    for (const lot of lots) {
      const forecast = v.forecast;
      const useForecast = forecast?.status === "OK" && lot.daysToExpiry >= 0 && lot.daysToExpiry <= forecast.dailyRates.length;
      const rate = useForecast ? forecast.dailyRate : v.avgDaily30;
      const base = {
        type: "EXPIRATION_RISK" as const,
        variantId: v.variantId,
        lotItemId: lot.lotItemId,
        valueAtRisk: 0,
      };
      const common = {
        lotNumber: lot.lotNumber,
        expirationDate: lot.expirationDate,
        daysToExpiry: lot.daysToExpiry,
        lotQuantity: lot.quantity,
        costPrice: v.costPrice,
      };

      if (lot.daysToExpiry < 0) {
        findings.push({
          ...base,
          severity: "CRITICAL",
          reasonCode: "EXPIRED_IN_STOCK",
          suggestedAction: "PREPARE_SCRAP",
          valueAtRisk: Math.round(lot.quantity * v.costPrice * 100) / 100,
          metrics: { ...common, atRiskQty: lot.quantity },
        });
        continue;
      }

      if (lot.status === "UNUSABLE") {
        findings.push({
          ...base,
          severity: "HIGH",
          reasonCode: "UNSELLABLE_NEAR_EXPIRY",
          suggestedAction: "PREPARE_SCRAP",
          valueAtRisk: Math.round(lot.quantity * v.costPrice * 100) / 100,
          metrics: { ...common, atRiskQty: lot.quantity, lotStatus: lot.status },
        });
        continue;
      }

      const projectedDemand = useForecast
        ? forecast.dailyRates.slice(0, lot.daysToExpiry).reduce((sum, value) => sum + value, 0)
        : rate * lot.daysToExpiry;
      const sellable = Math.min(lot.quantity, Math.max(0, Math.floor(projectedDemand - sellableAhead)));
      sellableAhead += sellable;
      const atRiskQty = lot.quantity - sellable;

      if (atRiskQty <= 0 || lot.daysToExpiry > MAX_HORIZON_DAYS) continue;
      if (!(rate > 0) && lot.daysToExpiry > lot.alertDaysBefore) continue;

      findings.push({
        ...base,
        severity: lot.daysToExpiry <= 14 ? "HIGH" : lot.daysToExpiry <= lot.alertDaysBefore ? "MEDIUM" : "LOW",
        reasonCode: rate > 0 ? "DEMAND_BELOW_STOCK_BEFORE_EXPIRY" : "NO_DEMAND_BEFORE_EXPIRY",
        suggestedAction: lot.daysToExpiry <= 14 ? "CLEARANCE" : "PROMOTE",
        valueAtRisk: Math.round(atRiskQty * v.costPrice * 100) / 100,
        metrics: {
          formula: "atRiskQty = lotQuantity - clamp(projectedDemand - units earlier-expiring lots can still sell, 0, lotQuantity)",
          ...common,
          alertDaysBefore: lot.alertDaysBefore,
          avgDaily30: Number(rate.toFixed(3)),
          rateSource: useForecast ? "FORECAST" : "AVG_30",
          projectedSellableQty: sellable,
          atRiskQty,
        },
      });
    }
  }
  return findings;
}
