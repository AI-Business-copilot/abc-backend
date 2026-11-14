import { HttpError } from "../../shared/http/http-error";
import type { InsightSettings } from "./types";

export const DEFAULT_SETTINGS: InsightSettings = {
  minHistoryDays: 14,
  slowMoving: { noSaleDays: 30, maxUnitsInWindow: 2 },
  declining: { periodDays: 14, minBaseUnits: 5, mediumPct: 30, highPct: 50 },
  overstock: { thresholdDays: 60, targetDays: 45 },
};

type Limit = [min: number, max: number];

const LIMITS = {
  minHistoryDays: [1, 60] as Limit,
  "slowMoving.noSaleDays": [7, 180] as Limit,
  "slowMoving.maxUnitsInWindow": [0, 1000] as Limit,
  "declining.periodDays": [7, 30] as Limit,
  "declining.minBaseUnits": [1, 10_000] as Limit,
  "declining.mediumPct": [1, 99] as Limit,
  "declining.highPct": [1, 100] as Limit,
  "overstock.thresholdDays": [14, 365] as Limit,
  "overstock.targetDays": [7, 365] as Limit,
};

function readNumber(source: unknown, path: keyof typeof LIMITS, fallback: number): number {
  let value: unknown = source;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return fallback;
    value = (value as Record<string, unknown>)[key];
  }
  if (value === undefined) return fallback;
  const [min, max] = LIMITS[path];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${path} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** Merges user input over a base, rejecting out-of-range values and inconsistent combinations. */
export function resolveSettings(input: unknown, base: InsightSettings = DEFAULT_SETTINGS): InsightSettings {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    throw new HttpError(400, "settings must be an object.");
  }
  const result: InsightSettings = {
    minHistoryDays: readNumber(input, "minHistoryDays", base.minHistoryDays),
    slowMoving: {
      noSaleDays: readNumber(input, "slowMoving.noSaleDays", base.slowMoving.noSaleDays),
      maxUnitsInWindow: readNumber(input, "slowMoving.maxUnitsInWindow", base.slowMoving.maxUnitsInWindow),
    },
    declining: {
      periodDays: readNumber(input, "declining.periodDays", base.declining.periodDays),
      minBaseUnits: readNumber(input, "declining.minBaseUnits", base.declining.minBaseUnits),
      mediumPct: readNumber(input, "declining.mediumPct", base.declining.mediumPct),
      highPct: readNumber(input, "declining.highPct", base.declining.highPct),
    },
    overstock: {
      thresholdDays: readNumber(input, "overstock.thresholdDays", base.overstock.thresholdDays),
      targetDays: readNumber(input, "overstock.targetDays", base.overstock.targetDays),
    },
  };
  if (result.declining.highPct < result.declining.mediumPct) {
    throw new HttpError(400, "declining.highPct must not be lower than declining.mediumPct.");
  }
  if (result.overstock.targetDays > result.overstock.thresholdDays) {
    throw new HttpError(400, "overstock.targetDays must not exceed overstock.thresholdDays.");
  }
  return result;
}
