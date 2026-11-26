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

Chủ cửa hàng chọn dòng, chỉnh số lượng rồi "Tạo đơn nháp": hệ thống tạo một PO trạng thái **`DRAFT`** cho mỗi nhà cung cấp (mã `AI-YYYYMMDD-...`). Tất cả nhóm nhà cung cấp và trạng thái gợi ý được ghi trong một giao dịch; nếu một nhóm lỗi thì không tạo nhóm nào. Yêu cầu lặp đối với gợi ý đã đặt bị từ chối, không tạo đơn trùng; nếu mất phản hồi hãy tải lại trang và kiểm tra đơn trước khi thao tác tiếp. Giá nhà cung cấp mặc định thay đổi sẽ yêu cầu phân tích lại. Đơn nháp có thể sửa/hủy, **không** nhận hàng được và không tính là hàng đang về cho đến khi bấm "Xác nhận đặt hàng" (`POST /api/purchases/orders/:id/confirm`, DRAFT → ORDERED).

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

