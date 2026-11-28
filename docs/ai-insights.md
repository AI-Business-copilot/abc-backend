# Cảnh báo tồn kho (AI giai đoạn 1 – rule-based)

Menu: **Trợ lý kinh doanh → Cảnh báo tồn kho** (`/app/insights`). Các rule chạy bằng Node/PostgreSQL; dự báo do Python tính, không dùng LLM. Chỉ dùng dữ liệu POS.

## Luồng

1. Cron 02:00 (giờ Việt Nam) hoặc nút "Phân tích lại" (quyền `ai_insights.manage`, tối đa 1 lần/phút/cửa hàng).
2. Tổng hợp lại chỉ số POS 60 ngày đến hết hôm qua (`BusinessDataService.rebuildPosMetrics`).
3. Dựng snapshot theo sản phẩm: tồn có thể bán, doanh số từng ngày (điền 0 cho ngày không bán), các lô còn hàng.
4. Chạy các luật thuần (`rules/*.ts`, không truy cập DB) rồi lưu kết quả vào `ai_insights`.

Tồn có thể bán = `quantity_on_hand − damaged_quantity`, không tính lô QUARANTINED, SCRAPPED, UNUSABLE hoặc đã quá hạn. Số bán = `max(0, units_sold − units_returned)` theo ngày.

Việc tạo lần chạy và công bố sử dụng cùng khóa theo cửa hàng. Cảnh báo, dự báo, gợi ý, lịch sử và trạng thái `SUCCEEDED` được ghi trong một giao dịch; lần chạy cũ bị thay thế không được công bố. Lỗi khi ghi sẽ hoàn tác giao dịch và đánh dấu lần chạy thất bại. Quy tắc này không phục hồi được snapshot cũ từ các bảng kết quả có thể thay đổi.

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

Giao diện Cảnh báo tồn kho ưu tiên số cảnh báo mới/đang xử lý theo mức độ; một SKU có thể có nhiều cảnh báo. Kết quả và số tồn là tại thời điểm phân tích, không khẳng định tình trạng kho hiện tại. Thời gian nhập ước tính không đồng nghĩa đã có đơn đặt hàng. Giá trị của từng cảnh báo được ghi rõ là giá vốn hàng liên quan hoặc doanh thu có thể bỏ lỡ; không cộng các giá trị này thành tổng tiền rủi ro vì khác bản chất và có thể trùng hàng. Vốn tồn kho trong phần mở rộng chỉ tính hàng có thể bán của sản phẩm đang hoạt động và đủ tuổi theo ngưỡng phân tích. Nếu lần chạy thất bại, đang chạy hoặc dữ liệu cũ, giao diện cảnh báo kết quả có thể chưa cập nhật.

Bảng hiển thị tóm tắt ngắn trong cột vấn đề; phần giải thích đầy đủ được giữ trong cửa sổ chi tiết. Bảng tự chia độ rộng cột trên màn hình lớn và có thể cuộn ngang trên màn hình hẹp.

## Vòng đời cảnh báo

Mỗi cảnh báo có `fingerprint = loại:variant:lô`, nên mỗi lần chạy là cập nhật chứ không tạo trùng. Không còn vi phạm thì thành `RESOLVED`; vi phạm lại thì mở lại. `DISMISSED` hoặc `ACKNOWLEDGED` được giữ nguyên cho đến khi hết hạn tạm ẩn (`snoozeUntil`) hoặc mức độ nặng hơn. Cảnh báo cũ không bị xóa.

## API (`/api/ai-insights`)

| Method | Đường dẫn | Quyền |
|---|---|---|
| GET | `/`, `/summary`, `/settings`, `/:id` | `analytics.read` |
| GET | `/inventory-outlook` | `analytics.read` |
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

- Chuỗi số bán POS **trước trừ trả**, tối đa 60 ngày. Với dự báo, hệ thống đối chiếu tổng biến động kho với tồn vật lý hiện tại, số bán POS theo ngày với ledger, và loại những ngày trước biến động đầu tiên hoặc trước ngày có sai lệch. Ngày không đối chiếu được đánh dấu không rõ, không mặc định là còn hàng.
- Cần ít nhất 28 ngày, không có ngày tồn kho không rõ trong 28 ngày gần nhất và ít nhất 7 ngày đóng cửa còn hàng. Lịch sử trước ngày không rõ gần nhất không được đưa vào các phương pháp dự báo. Các kiểm tra trên chỉ phát hiện một phần dữ liệu thiếu/sai: tồn cuối ngày là xấp xỉ, không phát hiện hết hàng trong ngày hay lịch sử hàng hỏng/cách ly/hết hạn; đối chiếu khớp không chứng minh ledger đầy đủ.
- Python so sánh trung bình 28 ngày, SES, Croston-SBA và LightGBM trên cùng các kỳ backtest 7 ngày không hết hàng; có ít nhất hai kỳ và cải thiện WAPE hơn 10% mới đổi khỏi trung bình. Không quan sát được nhu cầu bị mất khi hết hàng.
- LightGBM dùng artifact giả lập; xem hướng dẫn cấu hình, thực nghiệm và giới hạn tại [`abc-ml`](../../abc-ml/README.md). Mức tin cậy chỉ là phân loại heuristic theo backtest; không có khoảng dự báo đã hiệu chuẩn.
- Kết quả mới nhất lưu tại `ai_forecasts`; mỗi dự báo thành công cũng được ghi bất biến trong `ai_forecast_history`, theo cửa hàng, sản phẩm và lần chạy. Các dự báo được tạo trước khi bổ sung bảng này không tự xuất hiện trong lịch sử.
- Hai bảng thiết kế cũ `forecast_runs`/`forecast_results` không có luồng ứng dụng sử dụng; migration xóa chúng chỉ khi cả hai bảng rỗng.

## Nguy cơ hết hàng (AI-II05) – `stockout.ts`, `rules/stockout-risk.ts`

Mô phỏng tồn theo ngày (28 ngày), phân bổ đều tổng dự báo trong từng đoạn 1–7, 8–14 và 15–28; tính đơn đang về (`ORDERED`, `PARTIALLY_RECEIVED`, không tính đơn nháp). So ngày hết hàng với ngày bổ sung: chênh lệch < 0 là CRITICAL, < 7 HIGH, < 14 MEDIUM. Không tạo kịch bản cầu cao khi chưa có khoảng dự báo đáng tin cậy.

Đơn quá hạn vẫn được tính trong hàng đang về và giả định về sớm nhất ngày mai. Đây không phải xác nhận của nhà cung cấp; hệ thống cảnh báo để người dùng kiểm tra. Ngày dự kiến thiếu được ước tính từ ngày đặt và lead time của sản phẩm.

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

Chủ cửa hàng chọn dòng, chỉnh số lượng rồi "Tạo đơn nháp": hệ thống tạo một PO trạng thái **`DRAFT`** cho mỗi nhà cung cấp (mã `AI-YYYYMMDD-...`). Tất cả nhóm nhà cung cấp và trạng thái gợi ý được ghi trong một giao dịch; nếu một nhóm lỗi thì không tạo nhóm nào. Yêu cầu lặp đối với gợi ý đã đặt bị từ chối, không tạo đơn trùng; nếu mất phản hồi hãy tải lại trang và kiểm tra đơn trước khi thao tác tiếp. Giá nhà cung cấp mặc định thay đổi sẽ yêu cầu phân tích lại. Đơn nháp có thể sửa/hủy, **không** nhận hàng được và không tính là hàng đang về cho đến khi bấm "Xác nhận đặt hàng" (`POST /api/purchases/orders/:id/confirm`, DRAFT → ORDERED). Khi hủy đơn nháp, các gợi ý gắn với đơn trở lại trạng thái chờ xử lý để chủ cửa hàng có thể xem lại; nếu không cần nhập, chủ cửa hàng chọn "Không cần nhập". Gợi ý đã được bỏ qua có thể xuất hiện lại nếu mức khẩn cấp tăng.

Giao diện ưu tiên các gợi ý đang chờ, cho phép tìm theo tên/mã và lọc mức độ ngay trên danh sách. Lựa chọn được giữ khi lọc; chọn tất cả chỉ áp dụng cho các gợi ý có nhà cung cấp đang hiển thị. Chi phí là tạm tính theo giá gợi ý (với sản phẩm chưa có nhà cung cấp dùng giá vốn sản phẩm), chưa gồm phí khác; giá bằng 0 cần kiểm tra. Sau khi tạo đơn nháp, giao diện có liên kết mở từng đơn để kiểm tra và xác nhận. Gợi ý đã tạo đơn hiển thị liên kết tới đơn thay vì coi số lượng hoặc chi phí gợi ý cũ là giá trị hiện tại của đơn. Giao diện không hiển thị chi tiết mô hình hay nhãn dữ liệu giả lập, nhưng vẫn nêu dự báo có thể sai, dữ liệu cũ, hạn chế dữ liệu và đơn quá hạn. Lịch sử dự báo giữ các kỳ đối chiếu riêng cùng điều kiện so sánh.

## API bổ sung (`/api/ai-insights`)

| Method | Đường dẫn | Quyền |
|---|---|---|
| GET | `/replenishment`, `/forecasts/:variantId`, `/forecasts/:variantId/history` | `analytics.read` |
| PATCH | `/replenishment/:id` (`status`, `snoozeDays`) | `ai_insights.manage` |
| POST | `/replenishment/draft-orders` | `ai_insights.manage` + `inventory.receive` |

Ngưỡng mới (`settings.forecast`, `settings.stockout`) chỉnh trong cửa sổ "Ngưỡng cảnh báo".

Nếu Python không cấu hình, lỗi hoặc quá thời gian, lần chạy vẫn cập nhật rule độc lập và cảnh báo rõ `FORECAST_UNAVAILABLE`, nhưng giữ kết quả dự báo/cảnh báo hết hàng cũ. Không thể tạo PO nháp từ gợi ý cũ; cần phân tích lại thành công với dữ liệu đến hết hôm qua. Dự báo đã lưu trước khi chuyển sang Python cũng được coi là cũ.

### Đối chiếu 7/14/28 ngày

Lịch sử hiển thị tối đa 20 lần mới nhất cho sản phẩm. Sau khi một kỳ kết thúc, hệ thống tính lại số bán POS trước trừ trả từ đơn hoàn tất và chênh lệch tuyệt đối so với dự báo đã lưu; dữ liệu gốc thay đổi thì đối chiếu cập nhật, bản dự báo không đổi. Ledger và tồn vật lý được kiểm tra để ghi nhận ngày hết hàng hoặc không rõ. Chỉ xem lại tối đa 730 ngày và thông báo khi dữ liệu nằm ngoài phạm vi.

Dự báo thường hoàn tất sau 00:00 của ngày đầu, vì vậy phép so sánh theo ngày nguyên vẹn có thể bao gồm số bán trước khi dự báo có thể sử dụng. Các kỳ này được đánh dấu `PARTIAL_START`, không dùng chênh lệch đó làm điểm đánh giá đáng tin cậy. Khi xét thời điểm, dùng thời điểm muộn hơn giữa lúc ghi lịch sử và lúc phân tích hoàn tất; nếu thiếu thời điểm hoàn tất thì không coi là so sánh được, và báo `PUBLICATION_UNKNOWN` khi không có điều kiện kho ưu tiên hơn. Thời điểm hoàn tất là mốc ứng dụng ghi nhận, không phải bằng chứng chính xác thời điểm commit hoặc người dùng nhận kết quả.

Bên cạnh các tổng 7/14/28 ngày cũ, báo riêng hai đoạn đã có trong dự báo: ngày 8–14 (`d14 − d7`) và 15–28 (`d28 − d14`), so với số bán đúng những ngày đó. Nếu dự báo hoàn tất trước khi đoạn bắt đầu và các điều kiện kho đạt, đoạn có thể được đối chiếu mà không tính ngày đầu đã trôi qua. Đây là hai đoạn có độ trễ 7 và 14 ngày, không phải dự báo 7/14 ngày bắt đầu ngay sau khi phát hành. Không ngoại suy thêm ngày hoặc tự chia tổng cũ để tạo kỳ 28 ngày trọn vẹn.

Với artifact Python mới, hệ thống lưu thêm dự báo riêng cho 7/14/28 ngày bắt đầu từ ngày thứ hai sau `asOf` (thường là ngày mai), dùng đúng phương pháp đã chọn cho dự báo vận hành. LightGBM có ba model riêng cho các đoạn ngày 2–8, 9–15 và 16–29; phương pháp đơn giản tiếp tục dùng tốc độ không đổi. Dự báo này không thay thế dự báo 1–28 ngày dùng cho đề xuất nhập. Phép đối chiếu yêu cầu lần phân tích hoàn tất trước thời điểm bắt đầu kỳ; khi hoàn tất trễ, thiếu mốc hoàn tất, có ngày hết hàng hoặc tồn không rõ thì không đánh dấu là so sánh được. Bản dự báo cũ không được tính lại và có trạng thái không có dữ liệu. Kiểm thử trên dữ liệu giả lập không chứng minh tính chính xác cho cửa hàng thật.

Nếu có ngày hết hàng hoặc không rõ, báo thêm điều kiện tương ứng; bán POS không phải nhu cầu ẩn. Tồn cuối ngày không chứng minh còn hàng suốt ngày hay phát hiện hàng không bán được. Các mốc/đoạn từ cùng dự báo có thể liên quan nhau và không phải các mẫu độc lập.

## Dữ liệu demo

`npm run seed:ai-demo` tạo 60 ngày bán POS, tồn đầu và ledger bán hàng, 2 nhà cung cấp, một PO đang về và một kịch bản gồm chứng từ nhập, khách trả hàng, kiểm kho điều chỉnh giảm và xuất hủy cùng ledger tương ứng. Đây là dữ liệu giả lập, không chứng minh tính chính xác của dữ liệu thực. Các chứng từ bổ sung được ghi cùng tồn kho trong một giao dịch.

Không chạy trên dữ liệu cần giữ. Bước xóa khi chạy lại từ chối nếu sản phẩm đã có chứng từ nhập, trả, kiểm kho hoặc xuất hủy, kể cả chứng từ demo vừa tạo; cần kiểm tra và xử lý thủ công trước khi tạo lại bộ demo đó. Có thể dùng tiền tố mới cho lần seed khác.

Có thể đặt `AI_DEMO_PREFIX` thành một tiền tố riêng dạng `DEMO-...-` và truyền `businessId` để không ghi đè bộ demo khác. Cần kiểm tra trước cả tên và các liên kết nghiệp vụ; script không phải công cụ xóa dữ liệu cửa hàng.

Ca bán demo được tạo riêng. Trước khi xóa dữ liệu cũ theo tiền tố, script kiểm tra một số liên kết ngoài demo và thực hiện bước xóa trong một giao dịch; nếu có liên kết không an toàn thì từ chối.

Kiểm thử PostgreSQL tùy chọn cần chỉ định cửa hàng và SKU demo. Các bài kiểm thử đối chiếu/PO sử dụng giao dịch hoàn tác; kiểm thử đồng thời tạo một cửa hàng tạm `SUSPENDED` và xóa lại đúng cửa hàng đó sau khi kiểm thử. Không bật kiểm thử này trên môi trường không cho phép tạo dữ liệu thử.

```powershell
$env:AI_FORECAST_TEST_BUSINESS = "<businessId>"
$env:AI_FORECAST_TEST_SKU = "<SKU-demo>"
$env:AI_FORECAST_TEST_DEMO_PREFIX = "<tiền tố-demo>" # tùy chọn: kiểm tra chứng từ của SKU AT-TRANG-L
node --test tests\ai-forecast.postgres.test.cjs
$env:AI_FORECAST_CREATE_TEMP_BUSINESS = "1"
node --test tests\ai-forecast.postgres-concurrency.test.cjs
```

Kiểm thử luồng phân tích → dự báo Python → lịch sử → PO nháp có ghi và
**không hoàn tác** dữ liệu; chỉ chạy trên một database PostgreSQL dùng một lần
`forecast_integration` tại `127.0.0.1`. Database phải chỉ có một cửa hàng
`SUSPENDED` tên bắt đầu `FORECAST-ISOLATED-TEST-`, nhân viên đang hoạt động và
bộ demo mới với SKU có tiền tố demo. Cần một service Python riêng tại
`127.0.0.1` với artifact và token riêng. Test từ chối các điều kiện không khớp
và yêu cầu chưa có lần phân tích hay PO nháp; các kiểm tra này không thay thế
việc xác nhận database thực sự cô lập. Không bật trên database dùng chung.

Sau khi tự cấu hình `DATABASE_URL`, `DIRECT_URL`, `FORECAST_RESEARCH_URL`,
`FORECAST_RESEARCH_TOKEN` cho các service thử nghiệm và đặt ba biến fixture ở
trên, chạy:

```powershell
$env:AI_FORECAST_ISOLATED_FLOW = "1"
node --test tests\ai-forecast.postgres-flow.test.cjs
```

Sau kiểm thử, hủy database thử nghiệm theo quy trình của môi trường đó. Kiểm
thử này gọi service backend trực tiếp, không xác nhận giao diện browser hay
xác thực HTTP. Lần kiểm thử ngày 2026-11-25 dùng PostgreSQL 17 tạm, schema từ
`prisma db push` và trigger lịch sử từ migration tương ứng: không chạy toàn bộ
chuỗi migration hoặc xác minh mọi constraint/RLS của môi trường triển khai.

### Chạy tự động trên Windows

Runner sau tạo PostgreSQL và Python riêng trên localhost, dùng mật khẩu, token
và fixture giả lập mới; không dùng database hoặc service Python đang chạy:

```powershell
.\scripts\test-ai-forecast-isolated.ps1 -PostgresBin "C:\path\to\pgsql\bin"
```

Chạy từ thư mục backend. Cần binary PostgreSQL 17, OpenSSL (mặc định
`C:\Program Files\Git\usr\bin\openssl.exe`, có thể chỉ định `-OpenSsl`),
dependencies backend đã cài, Python tại `abc-ml\.venv\Scripts\python.exe` và
artifact `abc-ml\artifacts\run-next-day-42`. Backend yêu cầu Node >= 24 và
npm >= 11 theo manifest; lần kiểm thử trên máy này dùng Node 22.16/npm 10.9,
nên không xác nhận tương thích đầy đủ với phiên bản yêu cầu.

Runner tạo database một lần trong thư mục tạm có ACL, bật TLS cho PostgreSQL,
ghi dữ liệu demo và chạy bảy kiểm thử PostgreSQL/backend. Khi kết thúc hoặc gặp
lỗi, runner dừng các tiến trình đã tạo, đợi cổng đóng, xóa thư mục tạm và khôi
phục biến môi trường. Nếu không xác minh được việc dừng, runner báo lỗi và giữ
thư mục để xử lý thủ công; không xóa hoặc dừng service khác theo tên. Cổng
localhost được chọn động nên vẫn có khả năng xung đột với tiến trình khác.

Database chạy từ `prisma db push`, chỉ bổ sung trigger bất biến của lịch sử;
không thay thế kiểm thử migration, RLS hay tất cả constraint SQL. Một probe
riêng trên PostgreSQL 17 tạo stub `auth.users`, chạy thành công migration đầu
`20261022144500_auth_rbac_invitations`, nhưng migration tiếp theo
`20261029015517_add_lot_status` lỗi vì chưa có bảng `product_lots`. Đây là
bằng chứng thiếu baseline trong tình huống database trống với stub đó, không
phải đánh giá đầy đủ chuỗi migration hay hướng dẫn sửa database sản xuất.

## Chưa làm

- Đánh giá 7/14/28 ngày bắt đầu ngay sau thời điểm phát hành trong ngày; dự báo ngày đầy đủ mới bắt đầu ngày thứ hai sau `asOf` và yêu cầu lần chạy hoàn tất trước mốc đó.
- Mùa vụ và đánh giá mô hình ML bằng dữ liệu cửa hàng thực tế.

# Hiệu quả sản phẩm (AI-BC03)

Menu **Trợ lý kinh doanh → Hiệu quả sản phẩm** (`/app/product-performance`) phân tích POS trong quá khứ, không dùng ML hay forecast. `GET /api/business-data/product-performance` yêu cầu cả `analytics.read` và `finance.read`; cửa hàng được xác định từ phiên đăng nhập.

API nhận `from`, `to` (`YYYY-MM-DD`, tính cả hai đầu, tối đa 183 ngày), `search` (tên hoặc SKU), `sort` (`revenue`, `profit`, `units`), `page` và `pageSize` (tối đa 50). Tùy chọn `all=true` trả toàn bộ kết quả phù hợp trong một snapshot, không phân trang. Kỳ trước có cùng số ngày, liền trước kỳ đã chọn. Tổng hai kỳ tính trên toàn bộ sản phẩm trước khi tìm kiếm và phân trang; xếp hạng theo kỳ hiện tại. Tên sản phẩm và SKU là thông tin hiện tại. Mặc định giao diện chọn bảy ngày hoàn chỉnh gần nhất.

Hai kỳ được đọc trực tiếp từ đơn và phiếu trả hoàn tất trong một snapshot PostgreSQL, không ghi dữ liệu hay phụ thuộc bảng chỉ số đã tổng hợp. Giao diện tải toàn bộ kết quả một lần cho kỳ đã chọn; tìm kiếm, sắp xếp và phân trang xử lý trên snapshot đó, không tải lại POS. Bấm “Xem phân tích” để lấy snapshot mới; dữ liệu có thể thay đổi giữa các lần tải. Ngày ghi nhận là **ngày tạo** chứng từ theo `Asia/Ho_Chi_Minh`, không phải thời điểm hoàn tất. Chọn ngày hiện tại có thể cho kết quả chưa hoàn chỉnh.

Doanh thu thuần = doanh thu gộp − giảm giá dòng − hoàn tiền; giá vốn thuần = giá vốn bán − giá vốn hoàn lại hợp lệ; lợi nhuận gộp = doanh thu thuần − giá vốn thuần. Biên lợi nhuận chỉ tính khi doanh thu thuần dương. Phần trăm thay đổi chỉ tính khi giá trị kỳ trước dương. Số bán và trả hiển thị riêng; phiếu trả được tính trong kỳ tạo phiếu, kể cả khi đơn bán thuộc kỳ khác. Không cộng số đơn từng SKU để tính đơn duy nhất.

Hàng trả chỉ hoàn giá vốn nếu có thể nhập kho và có liên kết hợp lệ đến dòng đơn hoàn tất cùng cửa hàng. Giao diện nêu rõ cảnh báo khi loại dòng có sản phẩm không hợp lệ hoặc có dòng trả đủ điều kiện nhưng thiếu liên kết giá vốn. Kết quả không bao gồm chi phí vận hành và không phải lợi nhuận ròng; các kiểm tra không chứng minh dữ liệu nguồn đầy đủ. API vẫn trả cờ SKU giả lập, nhưng giao diện chủ cửa hàng không hiển thị nhãn này.

Giao diện làm nổi bật hai kỳ, tổng cửa hàng và mức tăng/giảm; nêu rõ khi không tính được tỷ lệ do kỳ trước không dương. Nếu kỳ hiện tại chưa kết thúc tại thời điểm đọc dữ liệu, kết quả được đánh dấu chưa đầy đủ. Bảng tóm tắt số bán/trả, doanh thu và lợi nhuận; cửa sổ chi tiết giữ số liệu hai kỳ và cho phép tìm, mở từng mã hàng. Số bán chưa trừ hàng trả; phiếu trả và đơn hoàn tất được tính theo ngày tạo.

Vì nguồn được đọc và tổng hợp lại cho mỗi lần tải, còn `all=true` truyền toàn bộ sản phẩm và biến thể về trình duyệt, cần kiểm tra hiệu năng và bộ nhớ theo dữ liệu cửa hàng trước khi mở rộng quy mô; không nên hiểu giới hạn 183 ngày là giới hạn số sản phẩm hoặc giao dịch.

# Nhận định tồn kho (AI-BC05)

Menu **Trợ lý kinh doanh → Nhận định tồn kho** (`/app/inventory-outlook`) và `GET /api/ai-insights/inventory-outlook` yêu cầu `analytics.read`. Chức năng chỉ đọc, dùng POS và kết quả phân tích tồn kho hiện có; không chạy lại phân tích, không tạo PO hoặc đổi trạng thái. API không trả giá vốn, giá bán, thành tiền, giá trị rủi ro hay JSON nguồn nguyên vẹn; các chỉ số được chọn theo danh sách trường cho phép.

API nhận `search` (tên/SKU, tối đa 100 ký tự), `type` (loại cảnh báo, `REPLENISHMENT`, `DRAFT_ORDER`), `priority`, `page` và `pageSize` (tối đa 100). Các cảnh báo `OPEN`/`ACKNOWLEDGED`, gợi ý `PENDING` và `ORDERED` gắn PO `DRAFT` được đọc cùng lần chạy trong snapshot `RepeatableRead`. Gom theo SKU, giữ từng cảnh báo và lô; sắp xếp theo mức hiện hành nặng nhất (`CRITICAL` → `HIGH` → `MEDIUM` → `LOW`), rồi tên, SKU, ID; sau đó mới lọc và phân trang. Tổng và các mức là số SKU duy nhất trước lọc. Các tín hiệu cũ và đơn nháp vẫn hiển thị nhưng không tạo mức ưu tiên hiện hành. Đơn nháp không phải đơn đã đặt, hàng đang về hay đề xuất mới.

Lần phân tích gần nhất phải thành công và được công bố nguyên tử theo cơ chế mới; lần chạy trước khi có cơ chế này phải chạy lại. Nếu chưa chạy, đang chạy, thất bại hay thiếu bằng chứng công bố, API không trả danh sách rỗng như một kết quả thành công. Tín hiệu rule quá 36 giờ hoặc từ lần chạy khác được đánh dấu cũ. Tín hiệu phụ thuộc dự báo và gợi ý nhập chỉ hiện hành khi dự báo sẵn sàng, dữ liệu đến hết hôm qua và thuộc lần chạy mới nhất. Nếu Python không khả dụng, cảnh báo hết hàng hoặc gợi ý được giữ từ lần trước không trở thành mới chỉ vì rule khác vừa chạy. Dự đoán hết hạn có thể dùng dự báo hoặc trung bình 30 ngày; nguồn được thể hiện riêng.

Mỗi nguồn hiển thị ngày dữ liệu bán POS và ngày hoàn tất phân tích tương ứng. Tồn và lô được đọc trong quá trình phân tích, không phải dữ liệu thời gian thực; thời điểm hoàn tất không phải bằng chứng thời điểm commit chính xác. API vẫn trả thông tin dữ liệu/mô hình giả lập, nhưng giao diện chủ cửa hàng không hiển thị nhãn này hay thông số mô hình; các lưu ý thiếu lịch sử, tồn không rõ và đơn quá hạn vẫn được trình bày. Không có cảnh báo trong danh sách không chứng minh không có rủi ro. API đọc toàn bộ SKU liên quan trước phân trang, vì vậy cần đánh giá hiệu năng và giới hạn bộ nhớ với cửa hàng lớn.

Giao diện dùng màu và nhãn mức độ tương tự trang Cảnh báo tồn kho; chọn thẻ mức độ để lọc, mỗi mã hàng hiển thị mức cao nhất của thông tin còn mới. Bảng ưu tiên hai vấn đề còn mới và nghiêm trọng hơn, kèm số vấn đề khác; cửa sổ chi tiết giữ từng cảnh báo và lô, giải thích lý do và hướng xử lý để chủ cửa hàng cân nhắc, kèm số liệu liên quan tùy chọn. Thời gian nhập ước tính không đồng nghĩa đã có đơn đặt hàng, và dự báo có thể khác thực tế; kiểm tra tồn và các lô trước khi xử lý.

# Giải thích biến động (AI-BC02)

Menu **Trợ lý kinh doanh → Giải thích biến động** (`/app/business-movement`) và `GET /api/business-data/business-movement?from=YYYY-MM-DD&to=YYYY-MM-DD` yêu cầu cả `analytics.read` và `finance.read`; cửa hàng lấy từ phiên. Chức năng chỉ đọc, dùng POS lịch sử, không dùng LLM hay dự báo. Kỳ trước liền kề, có cùng số ngày; tối đa 183 ngày/kỳ, không chọn ngày tương lai. Mặc định là bảy ngày hoàn chỉnh gần nhất; chọn hôm nay có cảnh báo kỳ chưa hoàn chỉnh.

API tái sử dụng một snapshot BC03 với toàn bộ sản phẩm và biến thể, cùng tổng, cảnh báo và thời điểm đọc. Tìm kiếm, chọn chỉ số và phân trang xử lý trên snapshot; bấm “Xem phân tích” để tải lại. Tên và SKU là thông tin hiện tại. Các quy tắc chứng từ, giá vốn, cảnh báo dữ liệu và giới hạn độ đầy đủ giống BC03 ở trên.

Đóng góp của sản phẩm hoặc SKU là giá trị kỳ này trừ kỳ trước. Hai nhóm tăng/giảm sắp theo độ lớn tuyệt đối, hiển thị năm sản phẩm đầu và tổng các sản phẩm còn lại; tổng các đóng góp bằng thay đổi toàn cửa hàng. Nếu các sản phẩm tăng và giảm bù trừ, cả hai nhóm vẫn được thể hiện. Phần trăm thay đổi không tính khi kỳ trước không dương.

Khoản mục được phân rã theo công thức: thay đổi doanh thu thuần = thay đổi tiền hàng − thay đổi giảm giá dòng − thay đổi hoàn tiền; thay đổi lợi nhuận gộp = thay đổi doanh thu thuần − thay đổi giá vốn thuần. Đóng góp của giảm giá, hoàn tiền và giá vốn có dấu ngược với thay đổi của chính khoản mục. Đây là hai cách nhìn cùng số liệu, không cộng phân rã khoản mục với đóng góp sản phẩm, và không chứng minh nguyên nhân. Chưa phân rã ảnh hưởng giá, sản lượng hay cơ cấu. Lợi nhuận gộp không phải lợi nhuận ròng.

Giao diện ưu tiên mức thay đổi của chỉ số và hai nhóm sản phẩm tăng/giảm, có tổng riêng cho từng nhóm; bảng chi tiết khoản mục được mở khi cần. Danh sách sản phẩm hiển thị chênh lệch tuyệt đối, không trình bày tỷ lệ so với kỳ trước như tỷ trọng đóng góp. Cửa sổ chi tiết cho phép tìm và phân trang mã hàng; khi tìm theo SKU, số liệu ở danh sách chính vẫn là tổng sản phẩm. Kỳ chưa kết thúc tại thời điểm đọc dữ liệu được cảnh báo ngay cả khi trang vẫn mở qua ngày mới. Giao diện không hiển thị nhãn dữ liệu giả lập, nhưng vẫn giữ các cảnh báo ảnh hưởng đến quyết định.

Toàn bộ sản phẩm và biến thể được truyền về trình duyệt; cần đo hiệu năng và bộ nhớ với cửa hàng lớn trước khi mở rộng quy mô.

# Hỏi đáp kinh doanh (AI-BC01)

Menu **Trợ lý kinh doanh → Hỏi đáp kinh doanh** (`/app/assistant`) và nút trợ lý nổi trên các trang nghiệp vụ dành cho thành viên đủ quyền đều dùng một ô hỏi tự nhiên, không cần chọn loại câu hỏi. Cửa sổ nổi giữ bản nháp và cuộc trò chuyện khi chuyển trang; có thể gửi nhiều câu trong cùng cuộc trò chuyện, nhấn Enter để gửi và Shift+Enter để xuống dòng. Lịch sử có thể mở khi cần; trang đầy đủ và cửa sổ nổi có lựa chọn hội thoại riêng nhưng cùng lịch sử được lưu. OpenAI nhận diện yêu cầu, backend tính và trình bày bằng mẫu nội bộ; không tự gửi kết quả truy vấn tới OpenAI.

Giao diện diễn đạt lại yêu cầu và tóm tắt kết quả theo dữ liệu đã lưu, hiển thị khoảng thời gian thực tế và các cảnh báo quan trọng; kết quả thiếu hoặc không khả dụng không được coi là không có rủi ro. Phần nguồn và giới hạn có thể mở để xem thêm. Với kết quả so sánh cũ, nội dung trả lời đã lưu vẫn xem được trong phần mở rộng và diễn giải AI cũ tiếp tục hiển thị nếu có.

### Đánh giá nhận diện câu hỏi

Bộ mẫu `tests/fixtures/assistant-classifier-cases.cjs` gồm câu hỏi giả theo nhóm hiện hỗ trợ, cách diễn đạt khác nhau, điều kiện kết hợp, câu hỏi tiếp theo, câu cần làm rõ và câu không hỗ trợ. `expected` là cách hiểu mong đợi; `previous` mô tả loại ngữ cảnh cần chuẩn bị, còn `expectedContext` khai báo các cờ ngữ cảnh mong đợi; cả hai không được gửi cho mô hình. Kiểm thử `tests/assistant-answer.routes.test.cjs` dựng evidence tổng hợp cho cả 21 ca có `previous`, gọi `/interpret` với và không có hội thoại trước, rồi xác minh các cờ, message ID và dữ liệu được gửi cho mô hình. Phản hồi phân loại trong kiểm thử này được mock theo `expected`, nên đây là kiểm chứng tích hợp ngữ cảnh của route, không phải đánh giá độ chính xác mô hình. Không dùng tên, mã hàng hay số liệu của cửa hàng thật.

Lưu kết quả nhận diện tương ứng từng `id` vào một mảng JSON. Mỗi phần tử dùng **một** trong hai dạng: `{"id":"rank-1","text":"{\"kind\":\"top_sellers\"}"}` cho văn bản JSON thô từ mô hình, hoặc `{"id":"rank-1","interpretation":{"kind":"top_sellers","hasPreviousRanking":false,"hasPreviousSkuList":false}}` cho JSON trả về từ `/api/assistant/interpret`. Không lưu khóa API. Từ thư mục backend, chạy:

```powershell
node scripts\evaluate-assistant-classifier.cjs <đường-dẫn-tệp-kết-quả.json>
```

Lệnh đọc tệp cục bộ, không gọi mạng hay cơ sở dữ liệu. Với văn bản thô, lệnh chạy qua cùng bộ kiểm tra và chuẩn hóa mà ứng dụng sử dụng; với kết quả API, giả định diễn giải đã qua bộ kiểm tra của endpoint và so thêm `hasPreviousRanking` với ngữ cảnh khai báo trong mẫu. Có thể khai báo `expectedContext` trên mẫu để chấm thêm các cờ ngữ cảnh API dạng boolean. Báo tổng và từng nhóm: số đúng, sai, bị từ chối, thiếu và độ chính xác (đúng/tổng mẫu); tách sai loại câu hỏi, sai tham số, lỗi trên nhóm cần từ chối/làm rõ, nhận nhầm yêu cầu không hỗ trợ, lỗi trên nhóm kết hợp và điều kiện kết hợp bị đổi/bỏ. Với các chỉ số rủi ro, `cases` là mẫu số, còn `incorrect`, `unsafeAcceptance` và `alteredConditions` là số lỗi quan sát được; thiếu/bị từ chối được tính vào `incorrect` của nhóm tương ứng, nhưng không phải `unsafeAcceptance` hay `alteredConditions`. Báo cáo `context` cho biết số phản hồi API có kiểm tra ngữ cảnh, số sai và số mẫu có ngữ cảnh mô tả nhưng chưa chấm đủ. Vì `previous` hiện chỉ là mô tả, không phải bằng chứng hội thoại API đã dựng, các ca này không chứng minh độ chính xác ngữ cảnh tiếp nối end-to-end. ID lạ, trùng hoặc cấu trúc tệp sai gây lỗi; thiếu, sai hoặc lệch cờ ngữ cảnh làm lệnh trả mã lỗi.

Đây là bộ mẫu ban đầu để phát hiện hồi quy, không phải ước lượng độ chính xác tổng quát. Mỗi đợt đo cần ghi phiên bản mô hình, thời điểm và điều kiện chạy; chỉ so sánh khi dùng cùng bộ mẫu và ngữ cảnh. Đánh giá này đo nhận diện, không thay thế kiểm thử quyền, tình huống dữ liệu cũ/thiếu, xử lý ngữ cảnh đồng thời hoặc đối chiếu số liệu nghiệp vụ. Kiểm thử bằng phản hồi giả chỉ xác minh công cụ và bộ kiểm tra, không chứng minh độ chính xác OpenAI.

### Kết quả OpenAI thực tế

Lượt chạy ngày **2026-11-28 11:13–11:14 ICT** dùng model `gpt-6.2-sol` qua `interpretQuestion` của ứng dụng, với toàn bộ 56 câu hỏi giả trong fixture tại thời điểm đó. Gửi đi chỉ có văn bản câu hỏi và cờ `hasPreviousRanking`; không gửi danh sách SKU, dữ liệu cửa hàng hay lịch sử hội thoại. Kết quả: **56/56 đúng (100%)**, không có phản hồi thiếu/từ chối; trong 16 ca cần từ chối/làm rõ không có ca nào được nhận nhầm, và trong 6 ca kết hợp không có điều kiện nào bị đổi hoặc bỏ. Fixture hiện có thêm hai cách hỏi về tồn nhiều trong danh sách trước; chúng chưa nằm trong lần chạy 56 câu này.

Lượt chạy bổ sung ngày **2026-11-28** dùng cùng model qua `interpretQuestion` với fixture hiện tại: **57/57 đúng (100%)**, không lỗi gọi API, từ chối hay phản hồi thiếu. Cả 15 ca cần từ chối/làm rõ đều không bị nhận nhầm; 6 ca kết hợp không đổi/bỏ điều kiện. Chỉ gửi câu hỏi và `hasPreviousRanking`, không gửi dữ liệu kinh doanh. Đây vẫn là một lần đo nhỏ trên mẫu do nhóm phát triển viết, không phải độ chính xác kỳ vọng ngoài thực tế.

Trong báo cáo chạy trực tiếp, 22 ca tiếp nối được đánh dấu **chưa chấm context**: phép đo gọi bộ phân loại với câu hỏi và cờ `hasPreviousRanking`, không dựng hội thoại. Riêng endpoint có kiểm thử context bằng evidence tổng hợp; các kiểm thử đó không phải hội thoại hay dữ liệu cửa hàng thật và không xác nhận độ chính xác ngoài thực tế.

Các câu hỏi bán chạy dùng truy vấn nội bộ phiên bản 1 gồm xếp hạng theo số bán trước trả trong 7 ngày hoàn chỉnh, tối đa 5 mã, rồi tùy chọn một điều kiện hết hàng cao/khẩn cấp, tồn nhiều, gợi ý nhập đang chờ hoặc lô gần hạn. Truy vấn phiên bản 2 hỗ trợ ba cặp điều kiện: tồn nhiều + lô gần hạn, gợi ý nhập đang chờ + lô gần hạn, hoặc gợi ý nhập đang chờ + tồn nhiều. Truy vấn đã thực hiện và kỳ cụ thể được lưu trong `evidence.query`; lịch sử cũ không có `query` vẫn dùng được. Đây chưa phải API nhận truy vấn tùy ý và chưa hỗ trợ mọi tổ hợp hay phép biến đổi câu hỏi tiếp theo. Đường chuẩn hóa được bật mặc định; đặt `ASSISTANT_COMPOSABLE_SKU_ENABLED=false` cho backend và khởi động lại để quay về đường cũ cho bốn câu hỏi cũ; tổ hợp mới khi đó không khả dụng. Giá trị cấu hình không hợp lệ gây lỗi thay vì tự chọn đường xử lý.

Hợp đồng các khối trong giai đoạn này:

| Khối | Nguồn và điều kiện sử dụng | Căn cứ, cảnh báo và hành động |
|---|---|---|
| Xếp hạng bán chạy | POS, số bán trước trừ trả trong 7 ngày hoàn chỉnh; chỉ mã có số bán dương. | Tối đa 5 mã, số bán, kỳ và thời điểm đọc POS; báo dữ liệu bán không đầy đủ. Không có hành động riêng cho danh sách không lọc. |
| Nguy cơ hết hàng | Cảnh báo hiện hành HIGH/CRITICAL trong lần phân tích đủ mới, dự báo sẵn sàng. | Mức nguy cơ, ngày hết dự kiến nếu có và thời điểm phân tích; thiếu/cũ không được coi là an toàn. Kiểm tra tồn, hàng đang về và gợi ý nhập. |
| Tồn nhiều | Cảnh báo tồn nhiều hiện hành của lần phân tích đủ mới theo ngưỡng cửa hàng. | Tồn và số ngày đủ bán tại lần phân tích; dữ liệu thiếu/cũ được báo riêng. Kiểm tra tồn thực tế, tốc độ bán và hàng đang về. |
| Gợi ý nhập đang chờ | Gợi ý `PENDING` hiện hành trong lần phân tích đủ mới, dự báo sẵn sàng. | Số lượng, mức ưu tiên, ngày và nhà cung cấp nếu có; báo cảnh báo dữ liệu và hàng đang về. Kiểm tra lại trước khi quyết định, không tự đặt hàng. |
| Lô gần hạn | Tồn lô còn hàng, chưa hết hạn, trong ngưỡng cảnh báo của lô tại lúc đọc kho. | Hạn, số lượng, hàng hư và trạng thái lô; gồm hàng cách ly, tối đa 5 lô/mã và báo số bị lược. Gần hạn không đồng nghĩa không bán hết; kiểm tra từng lô và tình trạng có thể bán. |

Các khối đều giới hạn theo cửa hàng; đường hỏi đáp hiện yêu cầu `analytics.read`, `finance.read` và sự đồng ý chia sẻ. Nguồn POS, cảnh báo và tồn lô có thể có thời điểm đọc khác nhau. Khối lọc áp dụng sau xếp hạng, không phải lọc toàn cửa hàng rồi xếp hạng.

Ba cặp được phép, thứ tự chuẩn và loại căn cứ tương ứng được khai báo chung trong backend; nhận diện, đổi kỳ và gợi ý hành động cùng dùng khai báo này. Các cặp có lô gần hạn dùng chung bước lọc lô sau điều kiện đầu và giữ căn cứ của cả hai. Gợi ý nhập + tồn nhiều vẫn đối chiếu trong cùng kết quả phân tích, không tách thành hai lần đọc. Việc khai báo không tự mở các cặp khác; xác thực nguồn, độ mới và quyền tiếp tục nằm ở các dịch vụ và route tương ứng. Cấu trúc truy vấn và căn cứ đã lưu không thay đổi.

Nhóm kết hợp đầu tiên hỗ trợ tối đa 5 SKU bán nhiều nhất trong 7 ngày hoàn chỉnh gần nhất (số bán trước trừ trả), hoặc lọc trong 5 SKU đó cảnh báo `STOCKOUT_RISK` hiện hành mức HIGH/CRITICAL. Khi bằng số lượng, sắp theo tên sản phẩm, SKU rồi ID. Chỉ xem các cảnh báo OPEN/ACKNOWLEDGED của lần phân tích hiện hành; dữ liệu cũ hoặc dự báo chưa sẵn sàng được báo không khả dụng, không coi là không có rủi ro. Không có cảnh báo cao cũng không chứng minh còn đủ hàng. Nguồn POS và tồn kho có thời điểm đọc khác nhau và được hiển thị riêng.

Danh mục trả lời bán chạy mở rộng:

| Thông tin | Cách tính / giới hạn |
|---|---|
| Bán chạy và tồn nhiều | Chọn top 5 trước, đối chiếu cảnh báo `OVERSTOCK` OPEN/ACKNOWLEDGED hiện hành theo ngưỡng cửa hàng; phân tích cũ không khả dụng. |
| Bán chạy và lô sắp hết hạn | Chọn top 5 trước, đọc tồn lô hiện tại theo cửa hàng. Lô còn tồn, hạn từ hôm nay đến hết ngưỡng cảnh báo của lô (null dùng 30 ngày), bao gồm hàng hư, cách ly hoặc không bán được và thể hiện trạng thái. Tối đa 5 lô/mã, báo số còn lại. |
| Bán chạy và gợi ý nhập | Chọn tối đa 5 mã bán nhiều nhất trước, rồi lọc gợi ý nhập `PENDING` hiện hành. Giữ thứ tự bán chạy, không xếp lại theo mức ưu tiên. |
| Bán chạy, tồn nhiều và lô sắp hết hạn | Chọn top 5 trước, lọc lần lượt cảnh báo tồn nhiều hiện hành và lô gần hạn theo các quy tắc trên. Chỉ giữ mã thỏa cả hai; không xếp hạng lại trên toàn cửa hàng. Phân tích tồn cũ không khả dụng; dữ liệu thiếu được báo có thể chưa đầy đủ. |
| Bán chạy, gợi ý nhập và lô sắp hết hạn | Chọn top 5 trước, lọc gợi ý nhập đang chờ hiện hành, rồi tìm lô gần hạn trong những mã đó. Chỉ giữ mã thỏa cả hai, theo thứ tự bán chạy; kiểm tra tồn và hạn trước khi quyết định nhập. |
| Bán chạy, gợi ý nhập và tồn nhiều | Chọn top 5 trước, đối chiếu gợi ý nhập đang chờ và cảnh báo tồn nhiều hiện hành trong cùng kết quả phân tích. Giữ thứ tự bán chạy; thiếu thông tin tồn làm kết quả chưa đầy đủ. Kiểm tra tồn thực tế và hàng đang về trước khi quyết định nhập. |

Hai nguồn POS và tồn được đọc riêng. Lô sắp hết hạn không đồng nghĩa có nguy cơ không bán hết; kết quả không bao gồm lô đã hết hạn. Thiếu dữ liệu bán/cảnh báo làm kết quả có thể chưa đầy đủ. Không có kết quả không chứng minh hàng an toàn.

Câu hỏi “mã bán chạy nào có gợi ý nhập?” ghép xếp hạng bán trước trả hàng của 7 ngày hoàn chỉnh với khối gợi ý nhập đang chờ: chỉ kiểm tra top 5, không phải toàn bộ mã cần nhập. Gợi ý, cảnh báo tồn/hạn, lần phân tích và dự báo được đọc riêng sau POS, phải đủ mới; khi không sẵn sàng trả không khả dụng thay vì kết luận rỗng. Giữ cảnh báo dữ liệu thiếu, đơn đang về quá hạn và các cảnh báo tồn, bán chậm hoặc hạn dùng trên từng mã; không có gợi ý không chứng minh không cần nhập. Số lượng chỉ là gợi ý, không tạo đơn. Có thể đổi kỳ xếp hạng hoặc hỏi tiếp trên tập đã hiển thị; khi đổi kỳ, gợi ý là tại lúc trả lời chứ không phải tình trạng kho trong quá khứ. Tắt `ASSISTANT_COMPOSABLE_SKU_ENABLED` sẽ tắt câu hỏi này.

Câu hỏi “mã bán chạy nào cần nhập thêm nhưng có lô sắp hết hạn?” dùng cùng khối gợi ý nhập, sau đó đối chiếu lô theo quy tắc lô gần hạn. SKU thỏa hai điều kiện không có nghĩa chính lô gần hạn cần được nhập; gợi ý được tính ở cấp SKU, lô có thể bị cách ly hoặc hư hỏng. Giữ riêng thời điểm POS, lần phân tích và đọc lô, tối đa 5 lô mỗi SKU; dữ liệu có thể thay đổi giữa các lần đọc. Dữ liệu nhập/dự báo cũ không được coi là không có mã phù hợp. Hỏi tiếp “nên làm gì?” nêu cả kiểm tra nhập và xử lý lô, không tự đặt hàng.

Câu hỏi “mã bán chạy nào có gợi ý nhập nhưng đang tồn nhiều?” dùng cùng kết quả nhận định tồn kho cho hai điều kiện: gợi ý `PENDING` hiện hành và cảnh báo `OVERSTOCK` hiện hành với đủ số tồn, số ngày bán và ngưỡng. Thiếu các số này làm kết quả một phần, không kết luận rỗng đầy đủ. Dự báo chưa sẵn sàng hoặc phân tích cũ làm kết quả không khả dụng. Hai tín hiệu không tự chứng minh gợi ý sai; cần kiểm tra tồn thực tế, hàng đang về và kế hoạch bán. Có thể đổi kỳ bán hoặc hỏi tiếp “nên làm gì?”; không tự đặt hàng.

Hướng tiếp theo có thể mở rộng catalog theo nhóm tồn kho, lô, bán hàng, lợi nhuận và nhà cung cấp với kỳ/bộ lọc rõ ràng. Mỗi khả năng phải định nghĩa nguồn, quyền, kỳ, chất lượng và giới hạn trước khi công bố; không mặc định mọi tổ hợp đều được hỗ trợ.

Câu hỏi tiếp nối “trong số đó” dùng đúng danh sách 5 SKU của câu trả lời xếp hạng ngay trước đó trong cùng hội thoại; không gửi danh sách hoặc nội dung lịch sử cho AI. Nếu thiếu danh sách hoặc ngữ cảnh đã thay đổi, người dùng cần xem lại danh sách. Câu trả lời cũ vẫn xem được.

Câu hỏi tiếp nối “trong các mã vừa xem, mã nào có lô sắp hết hạn?” kiểm tra đúng các SKU đã hiển thị trong danh sách hàng hóa gần nhất, không xếp hạng lại hay mở rộng sang mã bị lược. Điều kiện lô, phạm vi cửa hàng, thời điểm đọc và giới hạn 5 lô/mã giống khối lô gần hạn ở trên. Danh sách trước không đầy đủ hoặc bị lược được cảnh báo; danh sách rỗng, không khả dụng hoặc không hợp lệ không dùng làm ngữ cảnh. Kết quả có thể tiếp tục dùng cho câu hỏi ưu tiên nhập, kèm lưu ý cần kiểm tra tồn và hạn.

“Trong số đó mã nào tồn nhiều?” đối chiếu cảnh báo `OVERSTOCK` còn hiện hành chỉ với các mã thuộc danh sách ngay trước đó, giữ thứ tự gốc và không truy vấn toàn cửa hàng. Cần phân tích rule tồn kho mới; phân tích cũ/không sẵn sàng trả không khả dụng. Vì outlook chỉ trả các SKU có insight hoặc gợi ý nhập đang hoạt động, SKU không xuất hiện trong kết quả outlook mới được xem là không có insight hiện hành; ngược lại, cảnh báo tồn nhiều hiện hành nhưng thiếu chỉ số bắt buộc làm kết quả một phần. Danh sách trước bị cắt cụt vẫn chỉ được dùng trong phạm vi mã đã hiển thị và được cảnh báo. OpenAI chỉ nhận câu hỏi cùng cờ ngữ cảnh; SKU và evidence không gửi đi. Kết quả này có thể tiếp tục dùng cho “nên làm gì?”, nhưng là gợi ý kiểm tra, không tự quyết định nhập/xử lý hàng.

Kiểm thử tích hợp cô lập chạy `node --test tests\assistant-synthetic-inventory.integration.test.cjs` từ `abc-backend`. Test gọi `abc-ml\synthetic.py` với seed cố định, chuyển dữ liệu POS và biến động tồn quan sát được vào `buildSnapshot`, rồi chạy rule engine, inventory outlook và phép lọc tiếp nối. Các truy vấn DB được thay bằng adapter trong bộ nhớ; không dùng database, API ngoài hay dữ liệu cửa hàng. `latent_demand`/`lost_demand` chỉ dùng làm oracle kiểm thử, không được đưa vào snapshot hay câu trả lời trợ lý. Đây kiểm tra tích hợp các hợp đồng dữ liệu, không hiệu chuẩn ngưỡng hay chứng minh độ chính xác cho cửa hàng thật.

Câu hỏi “cùng câu đó cho tuần trước” và “cùng câu đó cho kỳ liền trước” chạy lại truy vấn bán chạy đã chuẩn hóa gần nhất: tuần trước là thứ Hai–Chủ nhật trước tuần hiện tại theo giờ Việt Nam, kỳ liền trước là 7 ngày ngay trước kỳ đã xem. Backend tự kiểm tra truy vấn đã lưu, giữ nguyên thứ tự xếp hạng/lọc và các điều kiện, tính lại toàn bộ danh sách cho kỳ mới; không giới hạn vào SKU đã hiện. Lịch sử cũ thiếu truy vấn chuẩn hóa, câu hỏi khác hoặc ngữ cảnh thay đổi cần xem lại câu hỏi phù hợp. Cảnh báo tồn, dự báo và lô được đọc theo dữ liệu mới khi trả lời, **không** phản ánh tình trạng kho trong kỳ bán quá khứ. Tắt `ASSISTANT_COMPOSABLE_SKU_ENABLED` cũng tắt phép đổi kỳ. Chưa hỗ trợ kỳ tùy ý, thêm điều kiện trong cùng lượt hay so sánh hai kỳ bằng phép này.

Có thể hỏi tiếp “số bán các mã đó so với kỳ liền trước?” sau danh sách bán chạy không lọc, không rỗng và có truy vấn chuẩn hóa hợp lệ. Backend giữ đúng tối đa 5 mã và thứ tự đã hiển thị, đọc lại số bán POS trước trừ trả của từng mã trong kỳ đã xem và 7 ngày liền trước trong cùng snapshot; không xếp hạng lại hay so sánh hai bảng xếp hạng. Nếu mã không còn trong snapshot hai kỳ, báo không đủ dữ liệu thay vì coi số bán bằng 0. Có thể có số 0 thực sự khi mã có phát sinh ở kỳ còn lại. Thời điểm và cảnh báo chất lượng của danh sách gốc và snapshot đối chiếu được giữ riêng; dữ liệu đọc lại có thể khác câu trả lời trước. Không hỗ trợ câu hỏi mơ hồ, kỳ tuần/tháng theo lịch, chỉ số khác hoặc danh sách có bộ lọc tồn kho. Khi tắt `ASSISTANT_COMPOSABLE_SKU_ENABLED`, phép này không khả dụng. OpenAI không nhận danh sách hay lịch sử.

Có thể hỏi “mã đầu tiên còn bao nhiêu ngày bán?” hoặc “mã thứ 2 còn bao nhiêu ngày bán?” ngay sau một danh sách SKU đã hiển thị, gồm cả kết quả so sánh số bán. Backend kiểm tra duy nhất một vị trí được ghi rõ (`đầu tiên` hoặc `thứ` kèm số/chữ từ 1 đến 10), chọn mã theo đúng thứ tự hiển thị và chỉ truy vấn mã đó trong cửa hàng. Không chọn mã chưa hiển thị hay đoán vị trí. Số ngày là `daysOfCover` trong cảnh báo `LOW_STOCK` hoặc `OVERSTOCK` hiện hành của lần phân tích tồn kho đủ mới: tồn có thể bán chia cho tốc độ bán trung bình gần đây của hệ thống, có xử lý ngày hết hàng theo quy tắc hiện hành. Không suy ra số ngày nếu cảnh báo phù hợp không có, dữ liệu cũ/thiếu, mẫu số không dương hoặc các cảnh báo mâu thuẫn; không coi thiếu dữ liệu là 0 hoặc là hàng an toàn. Tồn là tại lần phân tích, không phải tức thời, và số ngày chỉ là ước tính không đảm bảo tương lai. Hiển thị cảnh báo chất lượng dữ liệu, khả năng từng hết hàng và danh sách nguồn bị lược nếu có. Quyền và ID tin nhắn trước được kiểm tra lại trước khi lưu; không gửi mã hay danh sách cho OpenAI.

Câu hỏi “vậy nên làm gì?” sau danh sách không rỗng có cảnh báo nguy cơ hết hàng, tồn nhiều, lô gần hạn, bán chậm và nguy cơ hết hạn, tồn nhiều và dự báo giảm, hoặc gợi ý nhập đang chờ được backend trả bằng các bước kiểm tra theo hợp đồng của điều kiện đã xem. Điều kiện kết hợp trả các bước tương ứng; lô hết hạn hoặc không thể bán cần xử lý theo quy định, không mặc định được bán. Chỉ áp dụng cho mã đã hiển thị, giữ cảnh báo dữ liệu thiếu, danh sách bị lược, đơn hàng về quá hạn và khả năng từng hết hàng khi có trong nguồn. Gợi ý dựa trên kết quả đã lưu, không đọc lại tồn hay khẳng định cảnh báo còn hiện hành; hiển thị các thời điểm liên quan hoặc báo chưa rõ và yêu cầu kiểm tra lại trước khi quyết định. Không tự tạo đơn hay thực hiện thao tác. Danh sách bán chạy không lọc, câu trả lời rỗng/không khả dụng và các kết quả chưa có hợp đồng không hỗ trợ phép này. Không hỗ trợ chỉ định một mã, thêm điều kiện hay hỏi số lượng trong cùng phép. Quyền, sự đồng ý và ID ngữ cảnh được kiểm tra trước khi lưu; OpenAI không nhận kết quả hoặc lịch sử.

Câu hỏi tiếp nối “trong các mã vừa xem, mã nào cần ưu tiên nhập?” lấy đúng các SKU đã hiển thị trong câu trả lời hàng hóa gần nhất, gồm bán chạy, nguy cơ hết hàng, bán chậm và hết hạn, lợi nhuận và nhập, tồn nhiều và dự báo giảm, hoặc kết quả ưu tiên nhập trước đó. Không truy vấn các mã bị lược khỏi màn hình; danh sách rỗng, không khả dụng, không hợp lệ hoặc câu trả lời gần nhất không phải danh sách SKU không được dùng làm ngữ cảnh. Chỉ đối chiếu gợi ý `PENDING` hiện hành của cửa hàng; xếp theo mức khẩn cấp (CRITICAL, HIGH, MEDIUM, LOW), ngày nên đặt sớm hơn (ngày chưa rõ xếp sau), rồi thứ tự trước đó. Không có gợi ý không chứng minh không cần nhập.

Kết quả nhắc khi danh sách trước bị lược hoặc chưa đầy đủ, cảnh báo dữ liệu dự báo chưa đầy đủ hay đơn hàng đang về quá hạn. Khi danh sách trước có vấn đề tồn nhiều hoặc hết hạn, hoặc SKU hiện có cảnh báo tồn nhiều, bán chậm hay hết hạn, cần kiểm tra lại trước khi nhập. Các con số chỉ là gợi ý, không tạo đơn; dữ liệu gợi ý cũ hoặc dự báo chưa sẵn sàng được báo không khả dụng. Nếu danh sách trong hội thoại thay đổi sau khi nhận diện hoặc trước khi lưu, yêu cầu bị từ chối. Hệ thống không tự gửi danh sách, mã hàng, gợi ý hoặc nội dung lịch sử tới OpenAI; câu hỏi người dùng nhập vẫn được gửi.

Nhóm kết hợp thứ hai trả lời hàng **vừa có cảnh báo bán chậm vừa có cảnh báo nguy cơ hết hạn**, đối chiếu theo SKU trong một snapshot `inventory-outlook`. Dùng cảnh báo OPEN/ACKNOWLEDGED hiện hành của lần phân tích mới nhất, mọi mức độ; cảnh báo đã ẩn hoặc cũ không được tính. Cảnh báo hết hạn là nguy cơ không bán hết trước hạn theo quy tắc FEFO, không phải mọi lô có ngày hết hạn gần. Lô đã hết hạn hoặc không thể bán được đưa vào và ghi rõ trạng thái riêng, với điều kiện cùng SKU cũng có cảnh báo bán chậm. Các quy tắc và ngưỡng của cửa hàng không thay đổi.

Kết quả đếm SKU sau khi kết hợp toàn bộ dữ liệu, hiển thị tối đa 10 SKU và 5 lô mỗi SKU, kèm số bị lược và liên kết đến trang nhận định tồn kho để tra cứu. Ưu tiên lô đã hết hạn, không thể bán, rồi lô có hạn gần; số lượng nguy cơ là ước tính tại thời điểm phân tích. Không có hai cảnh báo không chứng minh hàng an toàn. Lần phân tích chưa sẵn sàng hoặc đã cũ được báo không khả dụng; nếu dự báo, lịch sử bán hoặc thông tin cảnh báo chất lượng chưa đủ, kết quả được báo có thể chưa đầy đủ. Chưa hỗ trợ kỳ, ngưỡng, bộ lọc hay câu hỏi tiếp nối tùy ý cho nhóm này.

Nhóm kết hợp thứ ba tìm SKU có gợi ý nhập `PENDING` hiện hành và lợi nhuận gộp POS dương trong 30 ngày hoàn chỉnh gần nhất. Sau khi lọc, xếp theo tổng lợi nhuận gộp bằng tiền giảm dần, khi bằng nhau theo tên sản phẩm, SKU và ID; hiển thị tối đa 5 mã và tổng số mã đủ điều kiện. Không xếp theo tỷ suất hoặc lợi nhuận ròng. Lợi nhuận gộp đã trừ hàng trả và giá vốn theo quy tắc POS, chưa trừ chi phí vận hành; các cảnh báo chất lượng dữ liệu của POS vẫn áp dụng.

Gợi ý nhập phải thuộc lần phân tích mới nhất, còn hiệu lực và dự báo đã sẵn sàng; gợi ý đã ẩn hoặc đã tạo đơn nháp không được tính. Nếu gợi ý cũ hoặc dự báo chưa sẵn sàng thì kết quả không khả dụng. Nếu lịch sử, dự báo, hoặc dữ liệu POS chưa đầy đủ, kết quả được báo có thể thiếu hoặc sai lệch. Hiển thị riêng thời điểm đọc POS và lần phân tích tồn kho vì hai nguồn không cùng snapshot. Số lượng nhập là ước tính, không tự tạo đơn; đơn đang về quá hạn có thể chưa được xác nhận giao. Không có gợi ý không chứng minh không cần nhập. Chưa hỗ trợ kỳ, tỷ suất, bộ lọc hay câu hỏi tiếp nối tùy ý cho nhóm này.

Nhóm kết hợp thứ tư tìm SKU có cảnh báo `OVERSTOCK` OPEN/ACKNOWLEDGED hiện hành, mọi mức, và dự báo số bán bình quân 7 ngày đầy đủ bắt đầu từ ngày mai giảm **ít nhất 10%** so với bình quân POS trước trừ trả trong 30 ngày kết thúc vào ngày dữ liệu phân tích. So sánh bằng số chưa làm tròn; lọc toàn bộ rồi hiển thị tối đa 10 mã theo số ngày tồn giảm dần, khi bằng nhau theo tên, SKU và ID. Chỉ dùng `next-day-v1` thuộc lần chạy mới nhất, đã công bố trước kỳ, và có mốc bán dương; không thay dữ liệu thiếu bằng dự báo bằng 0. Tồn nhiều dùng quy tắc và ngưỡng cửa hàng, tốc độ sau trả có thể loại ngày hết hàng, khác với số bán trước trả dùng trong phép so sánh.

Cảnh báo, dự báo và tổng bán POS được đọc trong cùng giao dịch snapshot của cửa hàng. Tổng bán được đọc khi trả lời và có thể đã cập nhật sau lần phân tích; tồn là tại thời điểm phân tích, không phải tức thời. Dữ liệu cũ hoặc dự báo toàn cục chưa sẵn sàng được báo không khả dụng. SKU thiếu dự báo hợp lệ, mốc bán dương hoặc dữ liệu cảnh báo bị bỏ qua và đếm riêng; cảnh báo chất lượng hoặc SKU bỏ qua làm kết quả có thể chưa đầy đủ. Ngày hết hàng có thể làm số bán thấp hơn nhu cầu thực; dự báo không đảm bảo tương lai, không có kết quả không chứng minh tồn kho phù hợp. Không hỗ trợ kỳ, ngưỡng, bộ lọc hoặc câu hỏi tiếp nối tùy ý.

So sánh POS hỗ trợ doanh thu thuần hoặc lợi nhuận gộp của toàn cửa hàng, sản phẩm hoặc mã hàng so với kỳ liền kề có cùng số ngày. Kỳ được hỗ trợ: hôm nay, hôm qua, 7 hoặc 30 ngày hoàn chỉnh gần nhất, tuần này/tuần trước (tuần bắt đầu thứ Hai), tháng này/tháng trước, hoặc hai ngày cụ thể dạng `YYYY-MM-DD` có trong câu hỏi. Tuần/tháng này chỉ tính tới hôm nay, có thể chưa đầy đủ; dùng múi giờ Việt Nam. Kỳ tối đa 183 ngày, không kết thúc trong tương lai. Chỉ xem số liệu POS, không trả lời nguyên nhân, dự báo, lợi nhuận ròng hoặc kỳ so sánh tùy ý. Nếu thiếu phạm vi thì yêu cầu hỏi lại với đầy đủ thông tin; không gửi lịch sử cho AI để đoán phần thiếu.

Có thể hỏi tiếp “còn lợi nhuận gộp thì sao?” hoặc “còn doanh thu thì sao?” ngay sau một câu so sánh POS tương thích. Backend giữ nguyên cửa hàng, sản phẩm hoặc mã hàng và hai kỳ liền kề của câu trước, đổi chỉ số rồi đọc lại POS; số liệu mới có thể khác kết quả trước nếu dữ liệu đã thay đổi. Lợi nhuận không rõ là gộp hay ròng cần làm rõ; chưa hỗ trợ lợi nhuận ròng, tỷ suất, thay đổi kỳ hay đối tượng trong cùng phép này. Nếu căn cứ cũ thiếu nguồn, kỳ hợp lệ hoặc mã định danh cần thiết, hoặc đối tượng không còn trong dữ liệu so sánh, hệ thống yêu cầu hỏi lại thay vì đoán. Quyền và ngữ cảnh tiếp tục được kiểm tra khi nhận diện và trước khi lưu; OpenAI không nhận căn cứ hay lịch sử.

Có thể hỏi tiếp “xem chi tiết theo từng sản phẩm” sau so sánh toàn cửa hàng, hoặc “xem theo từng mã hàng” sau so sánh một sản phẩm. Backend giữ chỉ số và hai kỳ, đọc lại POS, chỉ lấy sản phẩm hoặc mã có phát sinh trong ít nhất một kỳ. Hiển thị tối đa 20 mục theo giá trị kỳ này giảm dần, sau đó theo tên/mã và ID; nêu tổng số và số chưa hiển thị. Trang Hiệu quả sản phẩm cho phép tra cứu thêm sau khi chọn lại khoảng thời gian. Nếu sản phẩm không còn trong snapshot, ngữ cảnh không tương thích hoặc đã thay đổi, yêu cầu bị từ chối, không tự mở rộng phạm vi. Cảnh báo dữ liệu, kỳ chưa kết thúc và giới hạn lợi nhuận gộp vẫn được nêu. Đây không phải xếp hạng theo mức biến động hay giải thích nguyên nhân; chưa hỗ trợ lọc, đổi kỳ/chỉ số trong cùng lượt hoặc hỏi tiếp từ danh sách chi tiết này. Không gửi kết quả hay lịch sử tới OpenAI.

Tên sản phẩm hoặc mã hàng phải được ghi nguyên văn trong câu hỏi. Backend đối chiếu không phân biệt hoa thường với tên/mã chính xác có phát sinh trong hai kỳ; không tìm thấy hoặc trùng khớp nhiều kết quả thì báo để hỏi lại, không tự chọn. `POST /api/assistant/conversations/:id/messages` nhận `question`, `metric`, `from`, `to` và tùy chọn `subjectType` (`store`, `product`, `sku`) và `subject` (tên/mã); các tham số `productId`, `variantId` cũ vẫn được hỗ trợ. API yêu cầu `analytics.read` và `finance.read`, lấy cửa hàng từ phiên, tính từ snapshot POS BC02 và kiểm tra sản phẩm/SKU thuộc snapshot. Câu trả lời, kỳ, số liệu, thời điểm đọc và cảnh báo được lưu làm căn cứ; cảnh báo dữ liệu và kỳ chưa kết thúc cũng được nêu trong câu trả lời. Các giới hạn và quy tắc POS của BC02 vẫn áp dụng.

`POST /api/assistant/interpret` nhận câu hỏi và tùy chọn `conversationId`, yêu cầu cùng hai quyền và sự đồng ý chia sẻ với OpenAI. Với so sánh, backend kiểm tra cấu trúc nhận diện, tính kỳ theo đồng hồ máy chủ và trả thông số có cấu trúc hoặc thông báo yêu cầu làm rõ. Giao diện tự gửi kết quả phân loại hợp lệ cùng `question` và `analysis` (`top_sellers`, `top_sellers_stockout`, `top_sellers_overstock`, `top_sellers_near_expiry`, `previous_stockout`, `previous_restock`, `slow_moving_expiry`, `profit_restock`, `overstock_forecast`) hoặc thông số so sánh tới API tin nhắn, không yêu cầu xác nhận từng truy vấn chỉ đọc. Phạm vi/cách hiểu được hiển thị bên câu trả lời, kể cả khi mở lại lịch sử; người dùng có thể sửa câu hỏi và gửi lại. Câu hỏi tiếp nối sử dụng danh sách gần nhất, không nhất thiết là danh sách gốc của câu trả lời cũ đang sửa. Với câu hỏi tiếp nối, gửi thêm `previousMessageId` được trả về khi nhận diện để phát hiện danh sách thay đổi sau khi nhận diện; `hasPreviousSkuList` cho biết có danh sách phù hợp để đối chiếu gợi ý nhập. Backend xác thực lựa chọn, kiểm tra quyền, truy vấn trong cửa hàng và lưu căn cứ. Các lựa chọn khác hoặc ngữ cảnh không hợp lệ bị từ chối; mô hình không tạo SQL hay thực hiện thao tác.

Migration `assistant_conversations` và `assistant_messages` lưu hội thoại theo cửa hàng và người dùng, không tự xóa theo thời gian. API `/api/assistant/conversations` hỗ trợ tạo, liệt kê (50 hội thoại mỗi trang), xem và xóa hội thoại của chính người dùng. Cả câu hỏi và câu trả lời được ghi trong cùng giao dịch với các quyền cần thiết. Khi xem hoặc thêm lượt, backend kiểm tra lại quyền lưu trên các tin nhắn; nếu thiếu quyền, không trả nội dung hội thoại. Người dùng vẫn có thể xóa hội thoại của mình sau khi bị thu hồi quyền xem.

Mặc định không cho phép gửi dữ liệu. Chủ cửa hàng có thể bật hoặc tắt cho cả cửa hàng tại trang hỏi đáp đầy đủ; cửa sổ nổi không có nút bật/tắt và hiển thị liên kết tới trang này nếu chưa được cho phép. Backend kiểm tra vai trò chủ cửa hàng và trạng thái cho phép trước mỗi yêu cầu. Ngừng chia sẻ không hủy yêu cầu đang xử lý hoặc thu hồi dữ liệu đã gửi. API `GET/PUT /api/assistant/openai-consent` đọc/cập nhật lựa chọn; chỉ chủ cửa hàng được cập nhật.

Bước nhận diện mọi câu hỏi tự nhiên, gồm cả so sánh POS, gửi câu hỏi và cờ cho biết có hay không có danh sách trước đó tới OpenAI Responses API. Không tự gửi số liệu, danh sách sản phẩm hoặc nội dung lịch sử; tuy nhiên câu hỏi tự do có thể chứa tên, mã hàng hoặc thông tin nhạy cảm do người dùng nhập. OpenAI xử lý dữ liệu theo chính sách của họ; `store: false` không phải cam kết xóa toàn bộ dữ liệu của nhà cung cấp. Cấu hình `OPENAI_API_KEY` và `OPENAI_MODEL` ở backend. Lỗi OpenAI được báo cho người dùng, không lưu câu trả lời giả thay thế.

# Mô phỏng lợi nhuận (AI-WS06)

Menu **Trợ lý kinh doanh → Mô phỏng lợi nhuận** (`/app/profit-simulation`) so sánh một SKU giữa kịch bản cơ sở và một kịch bản thay đổi trong 7, 14 hoặc 28 ngày từ ngày mai theo giờ Việt Nam. Kịch bản chỉ nằm trong bộ nhớ trang, mất khi tải lại; không sửa giá, tồn kho, đơn hàng hay lưu kịch bản. Không dùng LLM hoặc mô hình lợi nhuận riêng.

Các API `GET /api/business-data/profit-simulation/categories`, `GET /api/business-data/profit-simulation/variants`, `GET /api/business-data/profit-simulation/basis?variantId=...`, `POST /api/business-data/profit-simulation/calculate` yêu cầu cả `analytics.read` và `finance.read`; cửa hàng lấy từ phiên. Tìm danh mục theo tên và tìm SKU theo tên hoặc mã đều hỗ trợ `search`, `page` và `pageSize` (mặc định 25, tối đa 50); trả `hasMore` để duyệt tiếp, giao diện dùng 8 dòng/trang. Tìm SKU hỗ trợ thêm `categoryId`: UUID danh mục bao gồm sản phẩm thuộc danh mục đó và danh mục con trực tiếp; `uncategorized` lọc sản phẩm chưa phân loại; bỏ tham số để tìm tất cả. Danh mục và SKU được giới hạn theo cửa hàng. Các trang được đọc riêng nên danh sách có thể thay đổi giữa các lần tải. Bộ chọn thu gọn sau khi chọn SKU và có thể mở lại, lọc danh mục mà không mất kịch bản đang chỉnh; chọn SKU khác bắt đầu lại. API cơ sở đọc giá tham khảo hiện tại, lần chạy và forecast trong snapshot `RepeatableRead`. Giá vốn 0 có thể là giá chưa cấu hình; người dùng phải kiểm tra giả định. API tính toán chỉ đọc SKU trong cửa hàng, xác nhận kỳ bắt đầu ngày mai và không ghi dữ liệu.

Số lượng bán có thể nhập tay hoặc lấy tổng dự báo ngày đầy đủ `next-day-v1`. Chỉ dùng khi lần chạy gần nhất thành công, công bố đầy đủ, forecast READY, dữ liệu đến hết hôm qua, SKU thuộc đúng lần chạy, trạng thái OK và dự báo được công bố trước kỳ. Giao diện tự điền dự báo hợp lệ không vượt giới hạn vào cơ sở khi chọn SKU hoặc đổi kỳ; người dùng có thể sửa hoặc dùng lại số dự báo. Đổi kỳ đặt lại số lượng ở cả hai kịch bản và không tự sao chép sang kịch bản thay đổi. Dự báo không sẵn sàng hoặc vượt giới hạn không được thay bằng 0; người dùng nhập tay. Dự báo là số bán kỳ vọng trước trả hàng, không đảm bảo đủ hàng hay độ chính xác thực tế. Dự báo thập phân được làm tròn hai chữ số khi đưa vào giả định; thay đổi giá không tự thay đổi số lượng. Thông tin kỹ thuật và nhãn dữ liệu/mô hình giả lập không hiển thị trong giao diện chủ cửa hàng.

Giới hạn cho mỗi kịch bản: số lượng 0–1.000.000; giá bán và giá vốn 0–10.000.000.000; giảm giá 0–100%; chi phí vận hành cả kỳ 0–1.000.000.000.000. Giá trị là chuỗi thập phân không âm, tối đa hai chữ số lẻ. Để trống chi phí nghĩa là chưa có giả định, không phải 0.

Tính bằng Decimal: tiền hàng = lượng × giá; giảm giá = lượng × giá × tỷ lệ / 100; giá vốn = lượng × giá vốn/đơn vị. Làm tròn từng khoản tiền đến hai chữ số theo HALF_UP; doanh thu sau giảm giá = tiền hàng − giảm giá; lợi nhuận gộp = doanh thu sau giảm giá − giá vốn. Kết quả sau chi phí chỉ tính khi đã nhập chi phí; chênh lệch sau chi phí chỉ tính nếu cả hai kịch bản đều có chi phí. Tỷ lệ thay đổi chỉ tính khi giá trị cơ sở dương.

Đây là mô phỏng theo giả định, không bao gồm trả hàng, thuế hay chi phí chưa nhập; kết quả sau chi phí không phải lợi nhuận ròng. Forecast và giá tại thời điểm đọc không bảo đảm còn phù hợp khi người dùng ra quyết định.

Giao diện làm nổi bật khoảng ngày, dự báo số bán, chênh lệch lợi nhuận gộp và thông báo lãi/lỗ của kịch bản thay đổi; bảng thành phần và công thức có thể mở xem thêm. Giá vốn bằng 0 được cảnh báo ngay tại ô nhập. Các số tiền đang nhập có dòng định dạng theo tiền Việt để kiểm tra, nhưng dữ liệu nhập vẫn dùng dấu chấm cho phần thập phân, không dùng dấu phân cách hàng nghìn.

