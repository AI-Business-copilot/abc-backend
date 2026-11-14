# Cảnh báo tồn kho (AI giai đoạn 1 – rule-based)

Menu: **Trợ lý kinh doanh → Cảnh báo tồn kho** (`/app/insights`). Chạy hoàn toàn bằng Node/PostgreSQL, không dùng LLM. Chỉ dùng dữ liệu POS; báo cáo Shopee không tham gia (xem `online-reports-shopee.md`).

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

- Bán TB/ngày chưa loại các ngày hết hàng, nên nhu cầu của hàng hay hết có thể bị đánh giá thấp; được đánh dấu `possibleStockoutBias`.
- Vốn tồn kho dùng giá vốn hiện tại (`cost_price`), không phải giá nhập từng lô.
- Chưa dự báo theo mùa vụ và chưa đề xuất số lượng nhập (giai đoạn 2).
- Bảng cũ `daily_product_metrics` đã bị xóa; dữ liệu bán hàng nằm ở `channel_daily_product_metrics`.
