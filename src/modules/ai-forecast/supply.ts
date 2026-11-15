import type { SupplyProfile } from "../ai-insights/types";

export interface SupplierOption {
  supplierId: string;
  supplierName: string;
  supplyPrice: number;
  minOrderQty: number;
  orderMultiple: number;
  leadTimeDays: number | null;
  isPreferred: boolean;
}

export interface VariantSupplyInput {
  costPrice: number;
  leadTimeDays: number;
  reviewPeriodDays: number;
  minOrderQty: number;
  packSize: number;
}

export interface LeadTimeHistory {
  /** Median days from order date to receipt. */
  medianDays: number;
  receipts: number;
}

export const MIN_HISTORY_RECEIPTS = 2;

/**
 * Chooses the supplier (preferred, otherwise cheapest) and the lead time:
 * the supplier's own value, then the observed median from past receipts, then the product default.
 */
export function resolveSupply(
  variant: VariantSupplyInput,
  options: SupplierOption[],
  history: Map<string, LeadTimeHistory>,
  variantHistory: LeadTimeHistory | null,
): SupplyProfile {
  const chosen =
    options.find((option) => option.isPreferred) ??
    [...options].sort((a, b) => a.supplyPrice - b.supplyPrice)[0] ??
    null;

  const observed = chosen ? history.get(chosen.supplierId) ?? variantHistory : variantHistory;
  let leadTimeDays = variant.leadTimeDays;
  let leadTimeSource: SupplyProfile["leadTimeSource"] = "VARIANT";
  if (chosen?.leadTimeDays != null) {
    leadTimeDays = chosen.leadTimeDays;
    leadTimeSource = "SUPPLIER";
  } else if (observed && observed.receipts >= MIN_HISTORY_RECEIPTS) {
    leadTimeDays = Math.max(1, Math.round(observed.medianDays));
    leadTimeSource = "HISTORY";
  }

  const multiple = Math.max(1, chosen?.orderMultiple ?? 1, variant.packSize);
  return {
    supplierId: chosen?.supplierId ?? null,
    supplierName: chosen?.supplierName ?? null,
    unitCost: chosen?.supplyPrice ?? variant.costPrice,
    minOrderQty: Math.max(1, chosen?.minOrderQty ?? 1, variant.minOrderQty),
    orderMultiple: lcmCapped(chosen?.orderMultiple ?? 1, variant.packSize, multiple),
    leadTimeDays,
    leadTimeSource,
    reviewPeriodDays: variant.reviewPeriodDays,
    noSupplier: chosen === null,
  };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Smallest quantity step that satisfies both the supplier multiple and the pack size; falls back to the larger when huge. */
function lcmCapped(a: number, b: number, fallback: number): number {
  const x = Math.max(1, a);
  const y = Math.max(1, b);
  const lcm = (x / gcd(x, y)) * y;
  return lcm <= 10_000 ? lcm : fallback;
}
