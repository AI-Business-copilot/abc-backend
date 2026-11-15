import { addDays, daysBetween } from "../ai-insights/snapshot/build-snapshot";
import { SERVICE_LEVEL_Z } from "../ai-insights/settings";
import type { InsightSettings, Severity, VariantSnapshot } from "../ai-insights/types";
import { arrivalsFrom, assessRisk, projectStockout } from "./stockout";

export interface ReplenishmentSuggestion {
  variantId: string;
  supplierId: string | null;
  supplierName: string | null;
  suggestedQty: number;
  unitCost: number;
  amount: number;
  urgency: Severity;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  orderByDate: string | null;
  stockoutDate: string | null;
  details: Record<string, unknown>;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/** Rounds up to at least the minimum order and to a whole multiple (supplier multiple / pack size). */
export function roundOrderQty(raw: number, minOrderQty: number, orderMultiple: number): number {
  const needed = Math.max(Math.ceil(raw), Math.max(1, minOrderQty));
  const step = Math.max(1, orderMultiple);
  return Math.ceil(needed / step) * step;
}

/** Units in lots that will not be sold before expiring (lots are sold first-expired-first-out). */
export function unsellableLotUnits(v: VariantSnapshot, today: string, dailyRates: readonly number[]): number {
  const lots = v.lots
    .filter((lot) => lot.status !== "UNUSABLE" && lot.quantity > 0)
    .map((lot) => ({ qty: lot.quantity, days: daysBetween(today, lot.expirationDate) }))
    .filter((lot) => lot.days >= 0)
    .sort((a, b) => a.days - b.days);
  let consumed = 0;
  let unsellable = 0;
  for (const lot of lots) {
    if (lot.days > dailyRates.length) continue;
    const demand = dailyRates.slice(0, lot.days).reduce((sum, value) => sum + value, 0);
    const sellable = Math.min(lot.qty, Math.max(0, Math.floor(demand - consumed)));
    consumed += sellable;
    unsellable += lot.qty - sellable;
  }
  return unsellable;
}

/**
 * II03: order-up-to replenishment.
 *   target   = forecast demand over (lead time + review period) + safety stock
 *   position = sellable stock + goods already on order
 *   quantity = target - position, rounded to the supplier's minimum and multiple.
 * Only products whose position is at or below the reorder point (demand over lead time + safety stock),
 * or that are at stockout risk, get a suggestion.
 */
export function suggestReplenishment(v: VariantSnapshot, today: string, settings: InsightSettings): ReplenishmentSuggestion | null {
  const forecast = v.forecast;
  const supply = v.supply;
  if (!forecast || forecast.status !== "OK" || !supply || !(forecast.dailyRate > 0)) return null;

  const rate = forecast.dailyRate;
  const leadTime = supply.leadTimeDays;
  const protectionDays = leadTime + supply.reviewPeriodDays;
  if (protectionDays > forecast.dailyRates.length) return null;
  const z = SERVICE_LEVEL_Z[settings.forecast.serviceLevelPct] ?? SERVICE_LEVEL_Z[90];
  const configuredSafety = v.safetyStockQty > 0;
  const safetyStock = configuredSafety ? v.safetyStockQty : z * forecast.dailySigma * Math.sqrt(leadTime);

  const unsellable = unsellableLotUnits(v, today, forecast.dailyRates);
  const sellableStock = Math.max(0, v.stockAvailable - unsellable);
  const incoming = v.incoming ?? [];
  const incomingQty = incoming.reduce((sum, po) => sum + po.qty, 0);
  const position = sellableStock + incomingQty;

  const demandThrough = (days: number) => forecast.dailyRates.slice(0, days).reduce((sum, value) => sum + value, 0);
  const reorderPoint = demandThrough(leadTime) + safetyStock;
  const arrivals = arrivalsFrom(incoming, today);
  const risk = assessRisk(projectStockout(sellableStock, forecast.dailyRates, arrivals), arrivals, leadTime, settings.stockout);
  if (position > reorderPoint && !risk.level) return null;

  const target = demandThrough(protectionDays) + safetyStock;
  const rawNeed = target - position;
  if (rawNeed <= 0) return null;

  const suggestedQty = roundOrderQty(rawNeed, supply.minOrderQty, supply.orderMultiple);
  const stockoutDate = risk.stockoutOffset === null ? null : addDays(today, risk.stockoutOffset);
  const orderByDate = risk.stockoutOffset === null ? null : addDays(today, Math.max(0, risk.stockoutOffset - leadTime));

  return {
    variantId: v.variantId,
    supplierId: supply.supplierId,
    supplierName: supply.supplierName,
    suggestedQty,
    unitCost: supply.unitCost,
    amount: round(suggestedQty * supply.unitCost),
    urgency: risk.level ?? "LOW",
    confidence: forecast.confidence,
    orderByDate,
    stockoutDate,
    details: {
      formula: "qty = forecast(leadTime + reviewPeriod) + safetyStock - (sellableStock + onOrder), rounded up to min order and multiple",
      dailyRate: round(rate, 3),
      forecast14: round(forecast.totals.d14, 1),
      model: forecast.model,
      modelVersion: forecast.modelVersion,
      datasetKind: forecast.datasetKind,
      wape: forecast.wape === null ? null : round(forecast.wape, 3),
      leadTimeDays: leadTime,
      leadTimeSource: supply.leadTimeSource,
      reviewPeriodDays: supply.reviewPeriodDays,
      protectionDays,
      safetyStock: round(safetyStock, 1),
      safetyStockSource: configuredSafety ? "PRODUCT_SETTING" : `AUTO_${settings.forecast.serviceLevelPct}PCT`,
      stockAvailable: v.stockAvailable,
      unsellableLotUnits: unsellable,
      sellableStock,
      onOrder: incomingQty,
      incoming,
      position,
      reorderPoint: round(reorderPoint, 1),
      target: round(target, 1),
      rawNeed: round(rawNeed, 1),
      minOrderQty: supply.minOrderQty,
      orderMultiple: supply.orderMultiple,
      noSupplier: supply.noSupplier,
      slackDays: risk.slackDays,
    },
  };
}
