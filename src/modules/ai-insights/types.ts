import type { ForecastResult } from "../ai-forecast/forecast";

export const INSIGHT_TYPES = [
  "LOW_STOCK",
  "SLOW_MOVING",
  "DECLINING_SALES",
  "OVERSTOCK",
  "EXPIRATION_RISK",
  "STOCKOUT_RISK",
] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INSIGHT_STATUSES = ["OPEN", "ACKNOWLEDGED", "DISMISSED", "RESOLVED"] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

export const SALES_WINDOW_DAYS = 60;

export interface IncomingSupply {
  poId: string;
  poCode: string;
  qty: number;
  /** Expected arrival (YYYY-MM-DD); falls back to order date + lead time when the PO has none. */
  arrivalDate: string;
  /** The expected date is already in the past but the goods are not received yet. */
  overdue: boolean;
}

export interface SupplyProfile {
  supplierId: string | null;
  supplierName: string | null;
  /** Purchase price from the chosen supplier, or the product's cost price when no supplier is set up. */
  unitCost: number;
  minOrderQty: number;
  orderMultiple: number;
  leadTimeDays: number;
  leadTimeSource: "SUPPLIER" | "HISTORY" | "VARIANT";
  reviewPeriodDays: number;
  /** True when the product has no active supplier, so a PO cannot be drafted without choosing one. */
  noSupplier: boolean;
}

export interface LotSnapshot {
  lotItemId: string;
  lotNumber: string;
  expirationDate: string;
  quantity: number;
  alertDaysBefore: number;
  status: string;
}

export interface VariantSnapshot {
  variantId: string;
  sku: string;
  name: string;
  category: string | null;
  costPrice: number;
  leadTimeDays: number;
  safetyStockQty: number;
  stockAvailable: number;
  ageDays: number;
  /** Net units sold per day, oldest first, last element is the as-of day. Length SALES_WINDOW_DAYS. */
  dailySales: number[];
  /** Gross POS units sold per day, used as the demand forecasting target. */
  grossDailySales?: number[];
  sold7: number;
  sold14: number;
  sold30: number;
  sold60: number;
  /** Average units/day over the last 30 days, excluding days that closed with no stock (demand was cut). */
  avgDaily30: number;
  /** Per day, oldest first, same length as dailySales: true when end-of-day stock was zero. */
  stockoutDays: boolean[];
  /** Forecast-only closing-stock evidence; null means the ledger cannot verify the day. */
  forecastStockoutDays: Array<boolean | null>;
  daysSinceLastSale: number | null;
  possibleStockoutBias: boolean;
  lots: LotSnapshot[];
  /** Open purchase orders not yet received. Draft POs are not counted. */
  incoming?: IncomingSupply[];
  basePrice?: number;
  supply?: SupplyProfile;
  /** Set by attachForecasts before analysis. */
  forecast?: ForecastResult;
}

export interface Snapshot {
  /** Last complete sales day (YYYY-MM-DD). */
  asOf: string;
  /** Today in the business timezone (YYYY-MM-DD). */
  today: string;
  variants: VariantSnapshot[];
}

export interface Finding {
  type: InsightType;
  variantId: string;
  lotItemId: string | null;
  severity: Severity;
  reasonCode: string;
  suggestedAction: string;
  metrics: Record<string, unknown>;
  valueAtRisk: number | null;
}

export interface InsightSettings {
  minHistoryDays: number;
  slowMoving: { noSaleDays: number; maxUnitsInWindow: number };
  declining: { periodDays: number; minBaseUnits: number; mediumPct: number; highPct: number };
  overstock: { thresholdDays: number; targetDays: number };
  forecast: { minSeriesDays: number; serviceLevelPct: number };
  stockout: { highSlackDays: number; mediumSlackDays: number };
}
