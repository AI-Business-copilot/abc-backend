import type { Finding, Snapshot } from "../types";

const BUCKETS = [
  { key: "0-30", max: 30 },
  { key: "31-60", max: 60 },
  { key: "61-90", max: 90 },
  { key: ">90", max: Infinity },
] as const;

const round = (value: number) => Math.round(value * 100) / 100;

/** II08: how much money is tied up in stock. It is a run-level summary, not a per-product insight. */
export function buildInventoryCapitalSummary(snapshot: Snapshot, findings: Finding[]) {
  const slowIds = new Set(findings.filter((f) => f.type === "SLOW_MOVING").map((f) => f.variantId));
  const overIds = new Set(findings.filter((f) => f.type === "OVERSTOCK").map((f) => f.variantId));

  let total = 0;
  let slow = 0;
  let over = 0;
  const byCategory = new Map<string, number>();
  const byCover = new Map<string, number>(BUCKETS.map((b) => [b.key, 0]));
  byCover.set("no-sales", 0);
  const items: Array<{ variantId: string; sku: string; name: string; stockAvailable: number; capital: number }> = [];

  for (const v of snapshot.variants) {
    if (v.stockAvailable <= 0) continue;
    const capital = v.stockAvailable * v.costPrice;
    total += capital;
    if (slowIds.has(v.variantId)) slow += capital;
    if (overIds.has(v.variantId)) over += capital;

    const category = v.category ?? "Chưa phân loại";
    byCategory.set(category, (byCategory.get(category) ?? 0) + capital);

    const bucket = v.avgDaily30 > 0 ? BUCKETS.find((b) => v.stockAvailable / v.avgDaily30 <= b.max)!.key : "no-sales";
    byCover.set(bucket, (byCover.get(bucket) ?? 0) + capital);
    items.push({ variantId: v.variantId, sku: v.sku, name: v.name, stockAvailable: v.stockAvailable, capital: round(capital) });
  }

  const share = (value: number) => (total > 0 ? Number(((value / total) * 100).toFixed(1)) : 0);
  return {
    totalCapital: round(total),
    slowMovingCapital: round(slow),
    slowMovingSharePct: share(slow),
    overstockCapital: round(over),
    overstockSharePct: share(over),
    byCategory: [...byCategory.entries()]
      .map(([category, capital]) => ({ category, capital: round(capital), sharePct: share(capital) }))
      .sort((a, b) => b.capital - a.capital),
    byDaysOfCover: [...byCover.entries()].map(([bucket, capital]) => ({
      bucket,
      capital: round(capital),
      sharePct: share(capital),
    })),
    topProducts: items.sort((a, b) => b.capital - a.capital).slice(0, 10),
    costBasis: "Giá vốn hiện tại của sản phẩm (cost_price)",
  };
}
