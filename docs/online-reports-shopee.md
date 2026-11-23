# Online report import: Shopee (supplementary feature)

> **Scope.** The core product is offline/POS store management. This module only imports a Shopee revenue report so the owner can view and reconcile Shopee finances. It is **not** a multichannel sales or inventory feature, may be removed or extended later, and is deliberately isolated from `business-data`.

## What it does not do

- It does not sync Shopee orders, deduct inventory, or create POS orders, cash shifts, or stock movements.
- The report has no reliable SKU-level sold quantities, so Shopee data must not be used for demand forecasting, stockout prediction, or online inventory.
- If a store shares stock between POS and Shopee, system inventory can be higher than the physical stock because Shopee sales are not recorded. Such stores must adjust and count stock manually; AI stock features should not be treated as accurate for them.
- Shopee revenue is never merged with POS revenue; recognition timing differs.

## Code layout

- Backend: `src/modules/online-reports/shopee/` (`shopee-report.parser.ts`, `shopee-report.service.ts`, `shopee.routes.ts`), mounted in `src/routes/index.ts` at `/online-reports/shopee`.
- Frontend: `src/pages/online-reports/` (page and CSS), `src/api/shopee-reports.ts`, the route `/online-reports/shopee` in `src/app/router.tsx`, and the "BÁO CÁO BỔ SUNG" menu group in `src/components/layout/app-layout.tsx`.
- Shared with `business-data` only: `src/shared/dates/date-range.ts`, the base stylesheet, and small UI helpers in `src/pages/business-data/shared.tsx`.
- Data: tables `online_report_*` / `Channel*` models in Prisma. No separate permission exists; it reuses `business_data.manage`, `analytics.read`, and `finance.read`.
- Tests: `tests/online-reports.shopee.*.test.cjs`.

## Access

- Preview/import requires `business_data.manage` and `finance.read`.
- Import history and records require both `analytics.read` and `finance.read`.
- Every request is scoped to the authenticated user's active business. Uploaded workbooks are parsed in memory and are not retained.

## API

- `POST /api/online-reports/shopee/preview` — multipart field `file`; validates the workbook and returns counts, date range, finance totals and reconciliations without persisting.
- `POST /api/online-reports/shopee/import` — multipart field `file`; imports the report, skips rows already present in earlier batches, and rejects an exact file re-import.
- `GET /api/online-reports/shopee/imports` — up to 50 recent batches.
- `GET /api/online-reports/shopee/records?from=YYYY-MM-DD&to=YYYY-MM-DD` — financial rows, batches and quality metadata for the inclusive range (maximum 366 days).

These paths replaced `/api/business-data/shopee/*`, and `/api/business-data/ai-ready` no longer returns a `shopee` key.

## Data contract and limits

- Shopee revenue `Order` rows are the financial source. `Sku` rows are product identification only and are never added to order totals. The parser finds the revenue/Income sheet by name or required headers, scans for header rows, and maps fields from a controlled, versioned alias catalog rather than fixed column numbers. `Giá sản phẩm` and `Tổng tiền sản phẩm` are kept as separate canonical values if both appear.
- `Đơn hàng / Sản phẩm` identifies the row grain and `Loại đơn hàng` describes the order; the latter is not a row-type alias. Order settlement dates come from `Ngày hoàn thành thanh toán`; identifiers and fee rates are not money.
- The `Summary` sheet is scanned by label independently. Its values are stored in the batch summary and shown in preview/history, and comparable components are checked against sums of Income `Order` rows. A mismatch is shown as a difference and never silently corrected. Summary `Tổng hàng hóa` includes refunds while Income `Giá sản phẩm` does not, so they are not compared; `Tổng số tiền` is compared with `Tổng tiền đã thanh toán`.
- The report guide's formulas (product price = original price + seller subsidy; total revenue = total goods − discounts; total expenses = shipping + surcharge; total amount = revenue − expenses) are not used to infer mappings or recompute Summary totals.
- Numeric values under unrecognized, non-sensitive headers are stored as quarantined fields under their original labels and excluded from canonical totals. If several columns in one sheet resolve to the same canonical field, all of them are quarantined as duplicate mappings. Buyer-identifying, free-text, note, and account columns are excluded.
- `Adjustment` rows keep the signed amount and completion date. `Service Fee Details` and `Shipping Fee Discrepancy` rows are supplemental records and are not added to order-level fees.
- Uploads are `.xlsx` only, up to 10 MB. Unknown header vocabulary must be added to the catalog explicitly.
- Mapping version 5 applies to new imports. Earlier imports are not reprocessed, and files are not retained.
- Batch counts, totals, quarantine summaries and reconciliations describe the entire parsed file, not only newly inserted rows.
- A record is returned when its transaction or settlement date is in range; rows with neither date use the batch's overlapping report period, so the result is not a settlement-only total.
- `records` returns at most 2,000 rows (`recordsTruncated` marks overflow); batches are limited to the latest 50.

## Removal checklist

1. Delete `abc-backend/src/modules/online-reports/` and its mount line in `src/routes/index.ts`.
2. Delete `tests/online-reports.shopee.*.test.cjs`.
3. Delete `abc-frontend/src/pages/online-reports/` and `src/api/shopee-reports.ts`.
4. Remove the route in `src/app/router.tsx` and the "BÁO CÁO BỔ SUNG" menu group in `app-layout.tsx`.
5. Optionally reword the `business_data.manage` text in `src/lib/permission-label.ts`.
6. Optionally add a migration to drop the `online_report_*` data. The core business-data module does not depend on it.
