export type ForecastModelName = "MEAN_28" | "SES" | "CROSTON_SBA" | "LIGHTGBM";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface ForecastTotals {
  d7: number;
  d14: number;
  d28: number;
}

export interface ForecastComparison {
  model: ForecastModelName;
  totals: ForecastTotals;
  count: number;
  mae: number | null;
  wape: number | null;
  bias: number | null;
}

export interface ForecastResult {
  status: "OK" | "INSUFFICIENT_DATA";
  seriesDays: number;
  reason: "SHORT_HISTORY" | "CENSORED_HISTORY" | null;
  model: ForecastModelName | null;
  modelVersion: string;
  datasetKind: string;
  dailyRate: number;
  dailySigma: number;
  /** Segment totals distributed uniformly within days 1–7, 8–14 and 15–28. */
  dailyRates: number[];
  totals: ForecastTotals;
  wape: number | null;
  bias: number | null;
  confidence: Confidence | null;
  activeShare: number;
  stockoutShare: number;
  comparison: ForecastComparison[];
}
