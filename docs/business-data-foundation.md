# Business data foundation

The channel data foundation keeps POS operations and online marketplace reports as separate sources. It creates normalized, tenant-scoped data for later AI analysis without treating online settlements as POS sales, cash shifts, or store inventory.

## Migration and access

Review and apply `20261108100000_channel_data_foundation` before using the feature. The migration is not applied automatically.

- Shopee preview/import requires `business_data.manage` and `finance.read`; POS aggregation requires `business_data.manage` (granted to the business Owner by the migration).
- Import history and AI-ready financial data require both `analytics.read` and `finance.read`.
- Every request is scoped to the authenticated user's active business.
- Uploaded workbooks are parsed in memory and are not retained.

## API

- `POST /api/business-data/shopee/preview` — multipart field `file`; validates the workbook and returns row counts, date range, and finance totals without persisting it.
- `POST /api/business-data/shopee/import` — multipart field `file`; imports the report, ignores rows already present in prior batches, and rejects an exact file re-import.
- `GET /api/business-data/shopee/imports` — lists up to 50 recent batches.
- `POST /api/business-data/pos/aggregate` — JSON `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`; rebuilds POS daily product metrics for the inclusive range (maximum 366 days).
- `GET /api/business-data/ai-ready?from=YYYY-MM-DD&to=YYYY-MM-DD` — returns POS product metrics and Shopee financial/reconciliation rows separately for the inclusive range.

## Data contract and limits

- POS uses completed orders and completed returns. Sale metrics include gross item subtotal, applied line discounts, COGS, and units. Return metrics use the actual refund amount and returned quantity on the return day; COGS is reversed only for restockable items linked to a completed order line in the same business. Legacy rows referencing a product or order outside that business are excluded from metrics and reported in the aggregate response rather than violating tenant foreign keys.
- Day boundaries are `Asia/Ho_Chi_Minh`. Re-running an aggregation atomically replaces POS rows for that business and date range.
- Shopee `Doanh thu` `Order` rows are the financial source. `Sku` rows are product identification only and are never added to order totals.
- `Adjustment` rows retain the signed adjustment amount and adjustment completion date. `Service Fee Details` and `Shipping Fee Discrepancy` rows are supplemental reconciliation records and are not added to order-level fee values.
- This report does not supply reliable SKU-level sold quantities. Imported Shopee data must not be used to calculate product demand or online inventory.
- Buyer, bank-account, payment identity, and other buyer-identification columns are deliberately excluded. Only mapped financial fields, order/product identifiers, product names, dates, source sheet/row, and import metadata are retained.
- Uploads are `.xlsx` only, limited to 10 MB. The parser requires the supported Shopee `Doanh thu` layout; other sheets are optional supplements.
