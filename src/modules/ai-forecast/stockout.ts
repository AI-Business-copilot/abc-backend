import type { IncomingSupply } from "../ai-insights/types";

export const PROJECTION_DAYS = 28;

const dayDiff = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export interface Arrival {
  offset: number;
  qty: number;
}

/** Days from today until each open PO arrives. Overdue POs are assumed to land tomorrow at the earliest. */
export function arrivalsFrom(incoming: IncomingSupply[], today: string): Arrival[] {
  return incoming
    .filter((po) => po.qty > 0)
    .map((po) => ({ offset: Math.max(1, dayDiff(today, po.arrivalDate)), qty: po.qty }))
    .sort((a, b) => a.offset - b.offset);
}

export interface StockoutProjection {
  /** Day offset (0 = today) on which stock first runs out; null when it lasts through the horizon. */
  stockoutOffset: number | null;
  /** Offset of the first PO arrival; null when nothing is on the way. */
  firstArrivalOffset: number | null;
}

/** Walks day by day: demand is taken at the end of each day, arrivals are added at the start of theirs. */
export function projectStockout(
  stock: number,
  demand: number | readonly number[],
  arrivals: Arrival[],
  horizonDays = PROJECTION_DAYS,
): StockoutProjection {
  const firstArrivalOffset = arrivals.length ? arrivals[0].offset : null;
  const rates = typeof demand === "number" ? Array(horizonDays).fill(demand) as number[] : demand;
  if (stock <= 0 && rates[0] > 0) return { stockoutOffset: 0, firstArrivalOffset };
  let level = stock;
  for (let day = 0; day < Math.min(horizonDays, rates.length); day++) {
    for (const arrival of arrivals) if (arrival.offset === day) level += arrival.qty;
    level -= rates[day];
    if (level < 0) return { stockoutOffset: day, firstArrivalOffset };
  }
  return { stockoutOffset: null, firstArrivalOffset };
}

export type RiskLevel = "CRITICAL" | "HIGH" | "MEDIUM" | null;

export interface RiskAssessment extends StockoutProjection {
  /** Days by which the product runs out before replenishment could arrive; negative = safe margin. */
  slackDays: number | null;
  level: RiskLevel;
  /** Days without stock before goods arrive. */
  gapDays: number;
}

/**
 * Compares the stockout day with the time stock can be replenished: the next PO arrival,
 * or today + lead time when nothing is on the way.
 */
export function assessRisk(
  projection: StockoutProjection,
  arrivals: Arrival[],
  leadTimeDays: number,
  slack: { highSlackDays: number; mediumSlackDays: number },
): RiskAssessment {
  const { stockoutOffset } = projection;
  if (stockoutOffset === null) return { ...projection, slackDays: null, level: null, gapDays: 0 };
  // Only a PO landing after the stockout day can rescue it; earlier ones were already used up.
  const rescue = arrivals.find((arrival) => arrival.offset > stockoutOffset);
  const replenishAt = rescue ? rescue.offset : leadTimeDays;
  const slackDays = stockoutOffset - replenishAt;
  let level: RiskLevel = null;
  if (slackDays < 0) level = "CRITICAL";
  else if (slackDays < slack.highSlackDays) level = "HIGH";
  else if (slackDays < slack.mediumSlackDays) level = "MEDIUM";
  return { ...projection, slackDays, level, gapDays: Math.max(0, replenishAt - stockoutOffset) };
}
