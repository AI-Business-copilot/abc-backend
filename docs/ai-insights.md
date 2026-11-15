# Cảnh báo tồn kho (AI giai đoạn 1 – rule-based)

Menu: **Trợ lý kinh doanh → Cảnh báo tồn kho** (`/app/insights`). Các rule chạy bằng Node/PostgreSQL; dự báo do Python tính, không dùng LLM. Chỉ dùng dữ liệu POS; báo cáo Shopee không tham gia (xem `online-reports-shopee.md`).

## Luồng

1. Cron 02:00 (giờ Việt Nam) hoặc nút "Phân tích lại" (quyền `ai_insights.manage`, tối đa 1 lần/phút/cửa hàng).
2. Tổng hợp lại chỉ số POS 60 ngày đến hết hôm qua (`BusinessDataService.rebuildPosMetrics`).
3. Dựng snapshot theo sản phẩm: tồn có thể bán, doanh số từng ngày (điền 0 cho ngày không bán), các lô còn hàng.
4. Chạy các luật thuần (`rules/*.ts`, không truy cập DB) rồi lưu kết quả vào `ai_insights`.

Tồn có thể bán = `quantity_on_hand − damaged_quantity`, không tính lô QUARANTINED, SCRAPPED, UNUSABLE hoặc đã quá hạn. Số bán = `max(0, units_sold − units_returned)` theo ngày.

## Các luật (mặc định)

Ký hiệu: S tồn bán được, d bán TB/ngày 30 ngày (`sold30 / min(30, tuổi SP)`), L thời gian nhập, SS tồn an toàn, C giá vốn.

| ID | Điều kiện | Mức độ |
|---|---|---|
| II01 Sắp hết | `S ≤ d×L + SS` (và d>0 hoặc SS>0) | S=0 và có bán: CRITICAL; `S ≤ SS`: HIGH; còn lại MEDIUM |
| II02 Bán chậm | S>0, tuổi ≥ 30 ngày, và (≥30 ngày chưa bán hoặc bán ≤2 trong 30 ngày) | ≥90 ngày: HIGH; 60–89: MEDIUM; còn lại LOW |
| II04 Doanh số giảm | 14 ngày gần nhất so với 14 ngày trước đó, kỳ trước ≥5 đơn vị, giảm ≥30% | ≥50%: HIGH; còn lại MEDIUM. Đang hết hàng: `DECLINE_POSSIBLY_STOCKOUT` |
| II07 Tồn dư | d>0 và `S/d > 60` ngày; dư = `S − d×45`, giá trị = dư×C | >120: HIGH; >90: MEDIUM; còn lại LOW |
| II06 Hết hạn | Theo FEFO: lô hết hạn sớm bán trước; `atRisk = SL lô − bán được trước hạn` | Đã hết hạn: CRITICAL; lô UNUSABLE: HIGH; ≤14 ngày: HIGH; ≤ ngày cảnh báo: MEDIUM; còn lại LOW |
| II08 Vốn tồn kho | Không phải cảnh báo; là báo cáo trong `ai_insight_runs.summary.capital` (theo danh mục, theo số ngày đủ bán, top 10, % ở hàng chậm/dư) | – |

Sản phẩm có dưới `minHistoryDays` (14) ngày dữ liệu bị bỏ qua ở các luật dựa trên nhu cầu (có cảnh báo trong lần chạy); luật hết hạn vẫn áp dụng. Điểm ưu tiên = trọng số mức độ (100/70/40/10) + tối đa 30 điểm theo tỷ lệ giá trị nguy cơ.

Mỗi cảnh báo lưu `metrics` (số liệu đầu vào) và `formula` để người dùng kiểm chứng.

## Vòng đời cảnh báo

Mỗi cảnh báo có `fingerprint = loại:variant:lô`, nên mỗi lần chạy là cập nhật chứ không tạo trùng. Không còn vi phạm thì thành `RESOLVED`; vi phạm lại thì mở lại. `DISMISSED` hoặc `ACKNOWLEDGED` được giữ nguyên cho đến khi hết hạn tạm ẩn (`snoozeUntil`) hoặc mức độ nặng hơn. Cảnh báo cũ không bị xóa.

## API (`/api/ai-insights`)

| Method | Đường dẫn | Quyền |
|---|---|---|
| GET | `/`, `/summary`, `/settings`, `/:id` | `analytics.read` |
| POST | `/run` | `ai_insights.manage` |
| PUT | `/settings` | `ai_insights.manage` |
| PATCH | `/:id` (`status`, `snoozeDays`) | `ai_insights.manage` |

Mọi truy vấn đều lọc theo `businessId` của người dùng. Quyền `ai_insights.manage` được cấp mặc định cho OWNER và có thể gán cho vai trò khác.

## Ngưỡng

Lưu trong `ai_insight_settings` (JSON, kiểm tra miền giá trị khi lưu); khóa thiếu dùng mặc định trong `settings.ts`. Lead time và tồn an toàn lấy từ từng sản phẩm.

## Hạn chế hiện tại

- Bán TB/ngày (`avgDaily30`) đã loại các ngày hết hàng (dựng lại tồn cuối ngày từ `inventory_ledger`); sản phẩm hết hàng quá nửa thời gian vẫn dùng trung bình thô và gắn `possibleStockoutBias`.
- Vốn tồn kho dùng giá vốn hiện tại (`cost_price`), không phải giá nhập từng lô.
- Chưa dự báo theo mùa vụ. Dự báo chỉ ngắn hạn (7–28 ngày).
- Bảng cũ `daily_product_metrics` đã bị xóa; dữ liệu bán hàng nằm ở `channel_daily_product_metrics`.

# Giai đoạn 2 – Dự báo, nguy cơ hết hàng và gợi ý nhập hàng

Menu: **Gợi ý nhập hàng** (`/app/replenishment`). Dự báo chạy trong `abc-ml`; rule và PO chạy trong Node/PostgreSQL, không dùng LLM.

## Dự báo nhu cầu (AI-DF01)

- Chuỗi số bán POS **trước trừ trả**, tối đa 60 ngày; ngày hết hàng được ước lượng từ tồn cuối ngày và có thể được bù. Cần ít nhất 28 ngày và 7 ngày không hết hàng trong 28 ngày gần nhất.
- Python so sánh trung bình 28 ngày, SES, Croston-SBA và LightGBM trên cùng các kỳ backtest 7 ngày không hết hàng; có ít nhất hai kỳ và cải thiện WAPE hơn 10% mới đổi khỏi trung bình. Không quan sát được nhu cầu bị mất khi hết hàng.
- LightGBM dùng artifact giả lập; xem hướng dẫn cấu hình, thực nghiệm và giới hạn tại [`abc-ml`](../../abc-ml/README.md). Mức tin cậy chỉ là phân loại heuristic theo backtest; không có khoảng dự báo đã hiệu chuẩn.
- Kết quả mới nhất (kèm so sánh, phương pháp và phiên bản) lưu tại `ai_forecasts`, một dòng mỗi sản phẩm; chưa lưu lịch sử nhiều lần dự báo.
- Hai bảng thiết kế cũ `forecast_runs`/`forecast_results` không có luồng ứng dụng sử dụng; migration xóa chúng chỉ khi cả hai bảng rỗng.

## Nguy cơ hết hàng (AI-II05) – `stockout.ts`, `rules/stockout-risk.ts`

Mô phỏng tồn theo ngày (28 ngày), phân bổ đều tổng dự báo trong từng đoạn 1–7, 8–14 và 15–28; tính đơn đang về (`ORDERED`, `PARTIALLY_RECEIVED`, không tính đơn nháp). So ngày hết hàng với ngày bổ sung: chênh lệch < 0 là CRITICAL, < 7 HIGH, < 14 MEDIUM. Không tạo kịch bản cầu cao khi chưa có khoảng dự báo đáng tin cậy.

## Gợi ý nhập hàng (AI-II03) – `replenishment.ts`, `supply.ts`

```
mục tiêu = tổng cầu dự báo trong (lead time + chu kỳ đặt) + tồn an toàn
vị thế   = tồn bán được + hàng đang về        (trừ phần lô sẽ hết hạn trước khi bán)
số lượng = làm tròn lên (mục tiêu − vị thế) theo MOQ và bội số đặt hàng
```

- Tồn an toàn: cấu hình sản phẩm nếu > 0, ngược lại `z × σ × √lead time` với σ là độ lệch chuẩn mẫu trên ngày không hết hàng và mức phục vụ giả định mặc định 90%; không cam kết đạt 90% thực tế.
- Chỉ gợi ý khi vị thế ≤ điểm đặt lại (`cầu dự báo trong lead time + tồn an toàn`) hoặc có nguy cơ hết hàng. Không gợi ý nếu lead time + chu kỳ đặt vượt 28 ngày; không ngoại suy dự báo. Lô hết hạn sau 28 ngày được tạm coi là có thể bán khi tính vị thế.
- Nhà cung cấp: ưu tiên nhà cung cấp "ưa thích", nếu không thì rẻ nhất. Lead time: của nhà cung cấp → trung vị thực tế (≥2 phiếu nhập trong 180 ngày) → cấu hình sản phẩm. MOQ/bội số: bội chung nhỏ nhất của bội số nhà cung cấp và quy cách đóng gói.
- Lưu ở `ai_replenishment_items` (một dòng mỗi sản phẩm). Dòng "Không cần nhập" chỉ mở lại khi hết hạn tạm ẩn hoặc mức khẩn cấp tăng; dòng đã tạo PO nháp được giữ nguyên.

## Đơn nháp

Chủ cửa hàng chọn dòng, chỉnh số lượng rồi "Tạo đơn nháp": hệ thống tạo một PO trạng thái **`DRAFT`** cho mỗi nhà cung cấp (mã `AI-YYYYMMDD-XXXX`). Đơn nháp có thể sửa/hủy, **không** nhận hàng được và không tính là hàng đang về cho đến khi bấm "Xác nhận đặt hàng" (`POST /api/purchases/orders/:id/confirm`, DRAFT → ORDERED).

## API bổ sung (`/api/ai-insights`)

| Method | Đường dẫn | Quyền |
|---|---|---|
| GET | `/replenishment`, `/forecasts/:variantId` | `analytics.read` |
| PATCH | `/replenishment/:id` (`status`, `snoozeDays`) | `ai_insights.manage` |
| POST | `/replenishment/draft-orders` | `ai_insights.manage` + `inventory.receive` |

Ngưỡng mới (`settings.forecast`, `settings.stockout`) chỉnh trong cửa sổ "Ngưỡng cảnh báo".

Nếu Python không cấu hình, lỗi hoặc quá thời gian, lần chạy vẫn cập nhật rule độc lập và cảnh báo rõ `FORECAST_UNAVAILABLE`, nhưng giữ kết quả dự báo/cảnh báo hết hàng cũ. Không thể tạo PO nháp từ gợi ý cũ; cần phân tích lại thành công với dữ liệu đến hết hôm qua. Dự báo đã lưu trước khi chuyển sang Python cũng được coi là cũ.

## Dữ liệu demo

`npm run seed:ai-demo` tạo thêm 2 nhà cung cấp (may mặc: lead 5 ngày, bội số 6; mỹ phẩm: lead 7 ngày, bội số 12) và một PO đang về.

## Chưa làm

- Đo độ chính xác dự báo theo thời gian (so dự báo với thực tế) – hiện chỉ có WAPE từ backtest.
- Mùa vụ và đánh giá mô hình ML bằng dữ liệu cửa hàng thực tế.

