const assert = require('node:assert/strict');
const { test } = require('node:test');

const { buildDemoLedgerPlan } = require('../scripts/ai-demo-ledger-plan.ts');

test('demo ledger keeps opening and sale balances within each lot', () => {
  const entries = buildDemoLedgerPlan(
    [
      { lotItemId: 'expired-lot', quantityOnHand: 6 },
      { lotItemId: 'sale-lot', quantityOnHand: 4 },
    ],
    [
      { daysAgo: 2, quantity: 3 },
      { daysAgo: 1, quantity: 1 },
    ],
  );

  assert.deepEqual(entries, [
    {
      lotItemId: 'expired-lot',
      transactionType: 'OPENING_STOCK',
      quantityChanged: 6,
      balanceAfter: 6,
      daysAgo: 61,
    },
    {
      lotItemId: 'sale-lot',
      transactionType: 'OPENING_STOCK',
      quantityChanged: 8,
      balanceAfter: 8,
      daysAgo: 61,
    },
    {
      lotItemId: 'sale-lot',
      transactionType: 'POS_SALE',
      quantityChanged: -3,
      balanceAfter: 5,
      daysAgo: 2,
    },
    {
      lotItemId: 'sale-lot',
      transactionType: 'POS_SALE',
      quantityChanged: -1,
      balanceAfter: 4,
      daysAgo: 1,
    },
  ]);
});

test('demo ledger handles a non-lot SKU and rejects invalid quantities', () => {
  const entries = buildDemoLedgerPlan(
    [{ lotItemId: null, quantityOnHand: 2 }],
    [{ daysAgo: 1, quantity: 3 }],
  );
  assert.deepEqual(
    entries.map(({ transactionType, quantityChanged, balanceAfter }) => ({
      transactionType,
      quantityChanged,
      balanceAfter,
    })),
    [
      { transactionType: 'OPENING_STOCK', quantityChanged: 5, balanceAfter: 5 },
      { transactionType: 'POS_SALE', quantityChanged: -3, balanceAfter: 2 },
    ],
  );
  assert.throws(
    () => buildDemoLedgerPlan([{ lotItemId: null, quantityOnHand: -1 }], []),
    /nonnegative integer/,
  );
  assert.throws(
    () => buildDemoLedgerPlan(
      [{ lotItemId: null, quantityOnHand: 1 }],
      [{ daysAgo: 61, quantity: 1 }],
    ),
    /before opening stock/,
  );
});
