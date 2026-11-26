export type DemoLedgerLot = {
  lotItemId: string | null;
  quantityOnHand: number;
};

export type DemoLedgerSaleDay = {
  daysAgo: number;
  quantity: number;
};

export type DemoLedgerEntry = {
  lotItemId: string | null;
  transactionType: "OPENING_STOCK" | "POS_SALE";
  quantityChanged: number;
  balanceAfter: number;
  daysAgo: number;
};

export function buildDemoLedgerPlan(
  lots: DemoLedgerLot[],
  saleDays: DemoLedgerSaleDay[],
  openingDaysAgo = 61,
): DemoLedgerEntry[] {
  if (!lots.length) throw new Error("At least one inventory lot is required.");
  if (!Number.isInteger(openingDaysAgo) || openingDaysAgo < 1) {
    throw new Error("openingDaysAgo must be a positive integer.");
  }

  const lotIds = new Set<string | null>();
  for (const lot of lots) {
    if (lotIds.has(lot.lotItemId)) throw new Error("Inventory lot IDs must be unique.");
    lotIds.add(lot.lotItemId);
    if (!Number.isInteger(lot.quantityOnHand) || lot.quantityOnHand < 0) {
      throw new Error("Lot stock must be a nonnegative integer.");
    }
  }

  const seenDays = new Set<number>();
  for (const sale of saleDays) {
    if (
      !Number.isInteger(sale.daysAgo)
      || sale.daysAgo < 1
      || sale.daysAgo >= openingDaysAgo
      || seenDays.has(sale.daysAgo)
    ) {
      throw new Error("Sale days must be unique positive integers before opening stock.");
    }
    if (!Number.isInteger(sale.quantity) || sale.quantity <= 0) {
      throw new Error("Sale quantities must be positive integers.");
    }
    seenDays.add(sale.daysAgo);
  }

  const soldLot = lots[lots.length - 1];
  const totalSales = saleDays.reduce((total, sale) => total + sale.quantity, 0);
  const balances = new Map<string | null, number>();
  const entries: DemoLedgerEntry[] = [];

  for (const lot of lots) {
    const openingQuantity = lot.quantityOnHand + (
      lot.lotItemId === soldLot.lotItemId ? totalSales : 0
    );
    balances.set(lot.lotItemId, openingQuantity);
    if (openingQuantity > 0) {
      entries.push({
        lotItemId: lot.lotItemId,
        transactionType: "OPENING_STOCK",
        quantityChanged: openingQuantity,
        balanceAfter: openingQuantity,
        daysAgo: openingDaysAgo,
      });
    }
  }

  for (const sale of [...saleDays].sort((a, b) => b.daysAgo - a.daysAgo)) {
    const balanceAfter = (balances.get(soldLot.lotItemId) ?? 0) - sale.quantity;
    if (balanceAfter < 0) throw new Error("Demo sales exceed the lot's opening stock.");
    balances.set(soldLot.lotItemId, balanceAfter);
    entries.push({
      lotItemId: soldLot.lotItemId,
      transactionType: "POS_SALE",
      quantityChanged: -sale.quantity,
      balanceAfter,
      daysAgo: sale.daysAgo,
    });
  }

  for (const lot of lots) {
    if ((balances.get(lot.lotItemId) ?? 0) !== lot.quantityOnHand) {
      throw new Error("Planned ledger does not reconcile to final lot stock.");
    }
  }

  return entries;
}
