export const INSIGHT_TYPES = ["LOW_STOCK", "SLOW_MOVING", "DECLINING_SALES", "OVERSTOCK", "EXPIRATION_RISK"] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INSIGHT_STATUSES = ["OPEN", "ACKNOWLEDGED", "DISMISSED", "RESOLVED"] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

export const SALES_WINDOW_DAYS = 60;

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
  sold7: number;
  sold14: number;
  sold30: number;
  sold60: number;
  avgDaily30: number;
  daysSinceLastSale: number | null;
  possibleStockoutBias: boolean;
  lots: LotSnapshot[];
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
}
