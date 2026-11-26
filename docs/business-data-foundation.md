# Business data foundation (POS)

The business data foundation turns POS operations into normalized, tenant-scoped daily product metrics for later AI analysis. The product scope is offline/POS store management; this data is the primary source for AI features.

The discontinued online-report import is no longer available. Migration `20261126232000_remove_online_report_tables` drops its two legacy tables and permanently deletes their imported data. Historical migrations remain unchanged.

## Migration and access

Apply the project migrations in order before use. They are not applied automatically. The `channel_daily_product_metrics` table remains in use for POS metrics.

- POS aggregation requires `business_data.manage` (granted to the business Owner by the migration).
- AI-ready data requires both `analytics.read` and `finance.read`.
- Every request is scoped to the authenticated user's active business.

## API

- `POST /api/business-data/pos/aggregate` — JSON `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`; rebuilds POS daily product metrics for the inclusive range (maximum 366 days).
- `GET /api/business-data/ai-ready?from=YYYY-MM-DD&to=YYYY-MM-DD` — returns `{ range, pos }` with POS product metrics for the inclusive range.

## Data contract and limits

- POS uses completed orders and completed returns. Sale metrics include gross item subtotal, applied line discounts, COGS, and units. Return metrics use the actual refund amount and returned quantity on the return day; COGS is reversed only for restockable items linked to a completed order line in the same business. Legacy rows referencing a product or order outside that business are excluded and reported in the aggregate response rather than violating tenant foreign keys.
- Day boundaries are `Asia/Ho_Chi_Minh`. Re-running an aggregation atomically replaces POS rows for that business and date range.
- The `orderCount` of a row is the number of orders containing that product; it must not be summed to count distinct orders.
