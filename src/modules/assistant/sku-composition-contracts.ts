export type SkuFilter =
  | { condition: "stockout_risk"; severities: ["HIGH", "CRITICAL"] }
  | { condition: "overstock" }
  | { condition: "pending_restock" }
  | { condition: "near_expiry"; window: "lot_warning"; includeExpired: false };

export type ComposedSkuFilters =
  | [Extract<SkuFilter, { condition: "overstock" }>, Extract<SkuFilter, { condition: "near_expiry" }>]
  | [Extract<SkuFilter, { condition: "pending_restock" }>, Extract<SkuFilter, { condition: "near_expiry" | "overstock" }>];

export type CompositionCondition = "overstock" | "pending_restock" | "near_expiry";
type CanonicalConditions = readonly ["overstock", "near_expiry"] | readonly ["pending_restock", "near_expiry" | "overstock"];

const compositions: ReadonlyArray<{
  conditions: CanonicalConditions;
  evidenceType: string;
  queryFilters: () => ComposedSkuFilters;
}> = [
  {
    conditions: ["overstock", "near_expiry"], evidenceType: "top_sellers_overstock_near_expiry_v1",
    queryFilters: () => [{ condition: "overstock" }, { condition: "near_expiry", window: "lot_warning", includeExpired: false }],
  },
  {
    conditions: ["pending_restock", "near_expiry"], evidenceType: "top_sellers_restock_near_expiry_v1",
    queryFilters: () => [{ condition: "pending_restock" }, { condition: "near_expiry", window: "lot_warning", includeExpired: false }],
  },
  {
    conditions: ["pending_restock", "overstock"], evidenceType: "top_sellers_restock_overstock_v1",
    queryFilters: () => [{ condition: "pending_restock" }, { condition: "overstock" }],
  },
];

export function skuCompositionForConditions(value: unknown) {
  if (!Array.isArray(value) || value.length !== 2 || value[0] === value[1]) return undefined;
  return compositions.find(({ conditions }) => conditions.every((condition) => value.includes(condition)));
}

export function skuCompositionForEvidence(value: unknown) {
  return compositions.find(({ evidenceType }) => evidenceType === value);
}
