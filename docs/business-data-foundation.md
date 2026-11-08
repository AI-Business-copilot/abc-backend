# Business data foundation

The channel data foundation keeps POS operations and online marketplace reports as separate sources. It creates normalized, tenant-scoped data for later AI analysis without treating online settlements as POS sales, cash shifts, or store inventory.

## Migration and access

Review and apply migrations `20261108100000_channel_data_foundation` and `20261108103000_quarantine_unmapped_finance_fields` before using the latest parser/API. The migrations are not applied automatically.

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
- Shopee revenue `Order` rows are the financial source. `Sku` rows are product identification only and are never added to order totals. The parser finds the revenue/Income sheet by its name or required headers, scans for header rows, and maps fields from the controlled, versioned alias catalog rather than fixed column numbers. The current catalog includes the official Income labels for product price, refunds, seller/platform discounts, shipping, fees, and taxes. `Giá sản phẩm` and `Tổng tiền sản phẩm` are retained as separate canonical values if both appear.
- In the inspected Shopee sample, `Đơn hàng / Sản phẩm` identifies the row grain and `Loại đơn hàng` describes the order; the latter is not a row-type alias. The header scanner selects a row with required column labels instead of rejecting an earlier row containing repeated merged group headers. Order settlement dates are read from `Ngày hoàn thành thanh toán`; non-financial identifiers and fee rates are not treated as money.
- The `Summary` sheet is scanned by label, independently from Income. Recognized summary values are stored in the import-batch summary and shown in preview/history; they are not added to AI-ready order totals. Comparable Summary components are checked against sums of Income `Order` rows. A mismatch is surfaced as a difference and never silently corrected.
- The sample's Summary `Tổng hàng hóa` includes refunds while Income `Giá sản phẩm` does not, so they are not directly compared. Summary `Tổng số tiền` is compared with Income `Tổng tiền đã thanh toán`; matching component checks require both fields to be present.
- The report guide defines these relationships: product price in Income = original price + seller product subsidy; total revenue = total goods - discounts; total expenses = shipping + surcharge; total amount = total revenue - total expenses. The parser does not infer a field mapping from these formulas or use an unverified component breakdown to recalculate Summary totals.
- Numeric values under unrecognized, non-sensitive headers are stored separately as quarantined fields using their original labels. They are excluded from canonical financial totals and must not be used by AI calculations until explicitly mapped. Buyer-identifying, free-text reason, note, and account-identifying columns are excluded.
- If multiple financial columns in one sheet resolve to the same canonical field, the parser quarantines all of those columns instead of choosing one or rejecting the workbook. The preview labels them as duplicate mappings; they do not contribute to totals or reconciliation until the ambiguity is resolved.
- Cross-field formulas are report-specific. The Shopee guide's formulas are documented above, but automated checks currently compare only explicitly labeled, semantically equivalent Summary and Income amounts. Extend arithmetic reconciliation only after confirming the exact labels/sign behavior against representative Shopee workbooks.
- `Adjustment` rows retain the signed adjustment amount and adjustment completion date. `Service Fee Details` and `Shipping Fee Discrepancy` rows are supplemental reconciliation records and are not added to order-level fee values.
- This report does not supply reliable SKU-level sold quantities. Imported Shopee data must not be used to calculate product demand or online inventory.
- Buyer, bank-account, payment identity, and other buyer-identification columns are deliberately excluded. Mapped fields and quarantined numeric fields are stored separately, alongside order/product identifiers, product names, dates, source sheet/row, and import metadata.
- Uploads are `.xlsx` only, limited to 10 MB. The parser supports known Shopee sheet/header aliases and optional supplement sheets; an unrecognized header vocabulary still needs to be added explicitly rather than guessed.
- Mapping version 5 applies to newly parsed imports. Previously imported reports are not automatically reprocessed, and uploaded files are not retained; reprocessing requires a separate deduplication/reimport strategy.
- Import-batch counts, finance totals, quarantined-field summaries, and reconciliation results describe the entire parsed file, not just newly inserted records. New batches also store the unique parsed row count so skipped duplicates can be distinguished. Older batches may not have this metadata.
- AI-ready Shopee rows include their source batch, sheet, row, and mapping version. A row is included if its transaction date or settlement date falls within the requested range; rows lacking both dates use the batch's overlapping report period. This selection is not a settlement-only financial total.
- AI-ready Shopee responses are capped at 2,000 rows, with `recordsTruncated` set only when more matching rows exist. Client-side counts and filters cover the returned rows only. Import history and overlapping report batches are limited to the latest 50.
