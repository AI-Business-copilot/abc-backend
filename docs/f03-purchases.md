# F03: dat mua va nhan hang

Mo ta conceptual phu hop voi schema hien tai. Module cung cap API doc du lieu,
tao nha cung cap, tao PO, nhan hang theo PO va cap nhat thanh toan.
Khong thay doi Prisma/schema hay migration.

- PurchaseOrder co nhieu PurchaseReceipt; PurchaseOrderItem luu orderedQty,
  receivedQty, unitPrice. PurchaseReceiptItem luu so luong thuc nhan va actualCost.
- PurchaseReceipt.poId va PurchaseReceiptItem.poItemId cho phep null, nen schema
  cung cho phep nhap mua truc tiep khong qua PO.
- Lot thuoc ProductVariant; ProductTemplate.hasLotTracking xac dinh quan ly lo.
- PurchaseReceipt chi co RECEIVED/CANCELLED. Kiem dem nhap dung token co chu ky,
  frontend giu token; chi tao PurchaseReceipt khi xac nhan. Khong luu nhap trong DB.
- paidAmount/debtAmount tren phieu nhan la so tien tong hop. Tung lan thanh toan
  moi duoc luu trong CashTransaction, gan voi CashShift cua nguoi thao tac.
  Supplier.debtAmount la so tong hop da luu cua nha cung cap.
- API nhan hang tang InventoryBalance, ghi InventoryLedger PURCHASE_RECEIPT,
  cap nhat ProductVariant.costPrice, so luong da nhan cua PO va cong no nha cung cap
  trong cung transaction. Gia von binh quan gia quyen theo tong ton SKU truoc nhan
  va gia thuc nhan; ton <= 0 thi dung gia thuc nhan. Gia von lam tron 2 chu so.

## API doc du lieu

Tat ca endpoint can Bearer token, membership cua cua hang, quyen `inventory.read`
va `finance.read` vi response chua gia mua va cong no. Dung co che RBAC hien co;
mac dinh OWNER co ca hai, STAFF chua co finance.read.
businessId lay tu membership; khong cho query cua hang khac.

| Method | Endpoint | Du lieu |
| --- | --- | --- |
| GET | /api/purchases/orders | PO, SKU, cac dot nhan, tong so luong va thanh toan |
| GET | /api/purchases/orders/:id | Chi tiet mot PO voi du lieu nhu tren |
| GET | /api/purchases/receipts | Phieu nhan, nha cung cap, nguoi lap, PO neu co |
| GET | /api/purchases/receipts/:id | Them dong SKU, lo, dong PO va ledger nhap lien quan |
| GET | /api/purchases/suppliers | Nha cung cap va cong no da luu |

Danh sach tra `{ items, pagination: { page, pageSize, total, totalPages } }`.
`page` mac dinh 1, `pageSize` mac dinh 20, toi da 100. Ho tro `search`.
PO/phieu nhan ho tro `supplierId`, `status`, `from`, `to` (YYYY-MM-DD, ca hai ngay
deu duoc tinh, theo UTC; PO loc orderDate, phieu nhan loc receivedAt).
Phieu nhan ho tro them `poId` de xem tung dot giao cua mot PO.
Search PO theo ma PO, ten nha cung cap hoac SKU; search phieu theo ma phieu,
ma PO, ten nha cung cap hoac SKU. Search nha cung cap theo ten, SDT, nguoi lien he.
UUID/filter sai tra 400; khong tim thay document trong cua hang tra 404.

Vi du: `/api/purchases/receipts?poId=<UUID>&status=RECEIVED&page=1&pageSize=20`.

Tien duoc serialize thanh chuoi decimal, tranh sai so so thuc. subtotal va
debtAmount cua document duoc tinh tu cac truong goc de khong phu thuoc vao cot
generated da duoc cai trong DB hay chua. Tong thanh toan cua PO chi tinh phieu
RECEIVED; phieu CANCELLED van hien trong lich su. Cong no PO la cong no cua
cac phieu da nhan, khong phai gia tri hang chua giao. receivedQty doc tu PO item.
Ledger la lich su nhap cua phieu, khong phai ton kho hien tai; xem ton hien tai
qua API inventory hien co. GET khong tao ledger hay sua lai du lieu.

## Kiem tra

`npx tsc --noEmit`

`node --test --test-isolation=none tests/purchases.test.cjs`

`node --test --test-isolation=none tests/purchases-write.test.cjs`

Test dung mock o database boundary; khong truy cap DB that.

## API ghi du lieu va huong dan test Postman

Chay backend bang `npm run dev`. Base URL mac dinh: `http://localhost:5000/api`.
Dang nhap frontend bang tai khoan OWNER co cua hang. Trong DevTools cua tab
frontend, Network -> request `/auth/me` -> Request Headers -> copy token sau
`Bearer`. Trong Postman chon Authorization -> Bearer Token. Mo truc tiep API tren
thanh dia chi se khong gui Authorization va tra 401.

Body cua cac request duoi la raw JSON, header `Content-Type: application/json`.
Quyen chung: `inventory.read` + `finance.read`. Tao nha cung cap, PO va nhan hang
can them `inventory.receive`, bao gom cap nhat thanh toan. Dung cac permission
hien co, chua co permission rieng cho finance.write. STAFF mac dinh khong co finance.read.

**Truoc khi nhan hang co tra tien hoac thanh toan them**, mo ca bang
`POST /api/purchases/cash-shifts` voi body `{ "openingCash": "0.00" }`.
API dung ca OPEN cua chinh nguoi dang nhap trong cua hang, hoac nhan `shiftId`
trong body nhan hang/thanh toan. Khong co ca OPEN thi giao dich co tra tien tra
409 va rollback; nhan hang paidAmount = 0 khong can ca. Cac API ca nay chi ho tro
mo/tim ca de ghi nhan chi nha cung cap, chua bao gom quy trinh dong ca/doi soat quy POS.

### 1. Tao nha cung cap (neu chua co)

`POST /api/purchases/suppliers`

```json
{
  "name": "Nha cung cap A",
  "phone": "0901234567",
  "contactPerson": "Anh An"
}
```

Tra 201. Copy `id` lam supplierId. `phone` va `contactPerson` khong bat buoc.
Lay SKU qua `GET /api/inventory/variants?search=...`; copy `items[].id` lam variantId.
SKU phai dang hoat dong va thuoc cua hang.

### 2. Tao PO

`POST /api/purchases/orders`

```json
{
  "poCode": "PO-2026-001",
  "supplierId": "<UUID nha cung cap>",
  "orderDate": "2026-10-28",
  "expectedDeliveryDate": "2026-10-30",
  "items": [
    {
      "variantId": "<UUID SKU>",
      "orderedQty": 10,
      "unitPrice": "50000.00"
    }
  ]
}
```

Tra 201, status ORDERED. Copy `id` cua PO va `purchaseOrderItems[0].id` cua dong PO.
orderDate/expectedDeliveryDate khong bat buoc; ngay mac dinh theo UTC.
Moi SKU chi xuat hien mot lan trong PO. Tao PO chua tang ton, chua tao cong no.

### 3. Nhan dot 1 va xac nhan nhap kho

`POST /api/purchases/orders/<UUID PO>/receipts`

SKU khong quan ly lo:

```json
{
  "receiptCode": "PR-2026-001",
  "paidAmount": "100000.00",
  "items": [
    {
      "poItemId": "<UUID dong PO>",
      "receivedQty": 4,
      "actualCost": "50000.00"
    }
  ]
}
```

Tra 201 voi phieu RECEIVED; PO thanh PARTIALLY_RECEIVED. Gia tri nhan 200000,
da tra 100000, cong no nha cung cap tang 100000. Ton tang 4 va co ledger nhap.
paidAmount khong bat buoc, mac dinh 0. Thoi diem nhan lay theo server.
Endpoint nay xac nhan nhap kho ngay, khong tao phieu nhan o trang thai nhap.

Voi SKU quan ly lo, moi dong can them:

```json
{
  "poItemId": "<UUID dong PO>",
  "receivedQty": 4,
  "actualCost": "50000.00",
  "lotNumber": "LOT-2026-A",
  "manufacturingDate": "2026-10-01",
  "expirationDate": "2027-10-01"
}
```

manufacturingDate khong bat buoc. Mot dong PO co the nhan nhieu lo bang nhieu dong
items cung poItemId; tong nhan khong duoc vuot phan con thieu. Lo da co phai trung
han su dung va ngay san xuat neu gui; API khong sua ngay cua lo cu.
SKU khong quan ly lo thi khong gui cac truong lo. SKU dang khoa kiem ke tra 409.

### 4. Nhan dot 2

Gui lai endpoint nhan hang voi receiptCode moi `PR-2026-002`, receivedQty = 6.
Thay paidAmount cho phu hop voi dot nay (vi du "0.00"). PO se thanh COMPLETED.
Tong ton da tang 10. PO COMPLETED/CANCELLED/CLOSED_SHORT khong nhan them duoc.

poCode va receiptCode bat buoc, duy nhat trong cua hang. Gui trung ma tra 409,
khong nhap ton lan nua. Khi retry sau mat ket noi, dung lai ma phieu cu va GET
de kiem tra ket qua; khong tu doi ma phieu vi co the nhan trung hang.

### 5. Thanh toan them cho phieu dot 1

`PATCH /api/purchases/receipts/<UUID phieu dot 1>/payment`

```json
{
  "paidAmount": "150000.00"
}
```

paidAmount la **tong tien da tra**, khong phai so tien tra them. Vi du truoc do
da tra 100000, gui 150000 nghia la tra them 50000. Cong no phieu con 50000 va
cong no nha cung cap giam 50000. Gui lai 150000 khong tru cong no them lan nua.
Khong duoc giam tien da tra hoac tra vuot totalAmount. Chi tra phieu RECEIVED.
Lich su tung lan thanh toan: GET `/api/purchases/receipts/<UUID phieu>/payments`.
Chua ho tro hoan tien hoac sua lan thanh toan cu.

### 6. Doi chieu ket qua

- GET `/api/purchases/orders/<UUID PO>`: status, receivedQty, remainingQty va totals.
- GET `/api/purchases/receipts/<UUID phieu>`: SKU, lo, thanh toan va inventoryLedger.
- GET `/api/inventory/variants`: ton hien tai va gia von.
- GET `/api/purchases/suppliers`: cong no nha cung cap.

400: body sai, nhan vuot, tra vuot/giam tien da tra. 401: thieu/sai token.
403: thieu quyen. 404: supplier/SKU/PO/phieu khong thuoc cua hang hoac khong co.
409: trung ma, PO da dong, lo khac ngay, khoa kiem ke hoac xung dot transaction.
Transaction Serializable duoc retry toi da 3 lan khi gap P2034. Moi lan nhan hang
va thanh toan hoac thanh cong toan bo, hoac rollback toan bo.

Chua cung cap API tra hang, nhap truc tiep khong PO hoac UI nhap hang.
Cac cot subtotal/debtAmount do DB generated khong duoc ghi truc tiep.

## API bổ sung cho các tình huống F03

Giữ nguyên Prisma/schema và migration. Các API dưới dùng cùng Bearer token,
quyền `inventory.read`, `finance.read`. API ghi cần thêm `inventory.receive`;
sửa phiếu đã nhập cần thêm `inventory.adjust`. STAFF mặc định vẫn chưa có finance.read.

| Method | Endpoint (sau /api/purchases) | Chức năng |
| --- | --- | --- |
| PATCH | /orders/:id | Sửa PO chưa có phiếu nhận |
| POST | /orders/:id/cancel | Hủy PO chưa nhận hàng |
| POST | /orders/:id/close | Đóng phần giao thiếu |
| PATCH | /receipts/:id/items | Sửa số lượng/giá của dòng đã nhận |
| POST | /orders/:id/receipt-drafts | Kiểm tra bản nháp và cấp token |
| POST | /orders/:id/receipt-drafts/confirm | Xác nhận nháp và nhập kho |
| POST | /cash-shifts | Mở hoặc lấy ca đang mở của người thao tác |
| GET | /cash-shifts/current | Xem ca đang mở (null nếu chưa có) |
| GET | /receipts/:id/payments | Lịch sử từng lần trả tiền |
| GET | /suppliers/:id/debt-reconciliation | Xem chênh lệch công nợ |
| POST | /suppliers/:id/debt-reconciliation | Áp dụng công nợ tính từ chứng từ |

### Sửa, hủy và đóng PO

PATCH `/api/purchases/orders/<poId>` hỗ trợ gửi một phần các trường poCode,
supplierId, orderDate, expectedDeliveryDate, items. Nếu gửi items thì đó là danh
sách đầy đủ thay thế, không phải chỉ các dòng muốn sửa. SKU còn giữ được giữ ID dòng.

```json
{
  "expectedDeliveryDate": "2026-11-05",
  "items": [
    { "variantId": "<UUID SKU>", "orderedQty": 12, "unitPrice": "49000.00" }
  ]
}
```

Chỉ sửa PO ORDERED chưa từng có phiếu nhận, kể cả phiếu đã hủy. Nháp token cũ
sẽ hết hiệu lực nếu thông tin PO thay đổi. Không sửa giá/số lượng của PO đã nhận;
trường hợp nhập sai thực tế dùng API sửa phiếu dưới đây.

POST `/api/purchases/orders/<poId>/cancel` không cần body: chỉ hủy khi chưa nhận,
không tác động tồn/nợ. PO đã nhận một phần phải dùng `/close`.

POST `/api/purchases/orders/<poId>/close` không cần body: chỉ áp dụng PO đã nhận
một phần và còn thiếu; chuyển CLOSED_SHORT, giữ nguyên orderedQty/receivedQty,
tồn và tiền. Không nhận thêm sau khi đóng. Gửi lại cùng thao tác đã thành công
không làm thay đổi số liệu lần nữa.

### Sửa nhập sai số lượng hoặc giá

PATCH `/api/purchases/receipts/<receiptId>/items`:

```json
{
  "expectedTotalAmount": "200000.00",
  "items": [
    {
      "id": "<UUID PurchaseReceiptItem, không phải poItemId>",
      "expectedReceivedQty": 4,
      "expectedActualCost": "50000.00",
      "receivedQty": 3,
      "actualCost": "49000.00"
    }
  ]
}
```

expectedTotalAmount/expectedReceivedQty/expectedActualCost lấy từ GET phiếu trước
khi sửa; nếu đã bị người khác thay đổi sẽ trả 409. Chỉ gửi các dòng muốn sửa.
Không đổi SKU/lô, không thêm/xóa dòng; số lượng mới phải > 0 và không vượt PO.
Không sửa nếu tổng mới nhỏ hơn tiền đã trả, SKU khóa kiểm kê, có phiếu trả NCC,
hoặc SKU có giao dịch kho sau phiếu này. Với hàng đã bán/xuất cần quy trình điều
chỉnh giá vốn riêng; API này trả 409 thay vì sửa ngược lịch sử bán hàng.

Khi sửa: cập nhật dòng nhận, số đã nhận của PO, trạng thái PO, tồn, giá vốn và nợ
trong cùng transaction. Giá vốn điều chỉnh theo giá trị tồn đang lưu cộng chênh
lệch giá trị phiếu, chia tồn mới, làm tròn 2 số; không phục dựng chính xác giá vốn
chưa làm tròn của quá khứ. Ledger cũ giữ nguyên, thêm STOCK_ADJUSTMENT_IN/OUT với
referenceDocType PURCHASE_RECEIPT_CORRECTION. Sửa giá thuần có quantityChanged = 0
và totalCostValue là chênh lệch có dấu. GET chi tiết phiếu trả cả ledger nhập và sửa.
Không lưu riêng lý do sửa/ảnh chụp toàn bộ phiếu cũ vì schema chưa có nơi lưu chúng.

### Kiểm đếm nháp rồi xác nhận

Backend cần `PURCHASE_DRAFT_SECRET` là khóa ngẫu nhiên ổn định dài ít nhất 32 ký tự.
Chỉ đặt trong abc-backend/.env; không đưa lên frontend. Đổi khóa sẽ làm nháp cũ
không còn hợp lệ. Nếu chưa cấu hình, API nháp trả 503; các API khác vẫn hoạt động.
Có thể tạo khóa bằng lệnh sau rồi gán vào .env và khởi động lại backend:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

POST `/api/purchases/orders/<poId>/receipt-drafts` với cùng JSON như API nhận hàng:

```json
{
  "receiptCode": "PR-DRAFT-001",
  "paidAmount": "0.00",
  "items": [
    { "poItemId": "<UUID dòng PO>", "receivedQty": 4, "actualCost": "50000.00" }
  ]
}
```

Response 201 có status DRAFT, persisted false, draftToken, expiresAt, receipt,
totalAmount và debtAmount. Nháp hợp lệ 1 giờ, chưa tạo phiếu, chưa tăng tồn hay nợ,
chưa ghi thanh toán. Frontend/Postman tự giữ token; không có API liệt kê nháp trên
server, không có lưu nháp xuyên thiết bị. Nháp không giữ chỗ số lượng hay mã phiếu.
Muốn sửa nháp, gửi lại JSON đầy đủ để lấy token mới. Bỏ token là bỏ nháp.

POST `/api/purchases/orders/<poId>/receipt-drafts/confirm`:

```json
{ "draftToken": "<token nhận ở bước trên>" }
```

Chỉ đúng người tạo, cửa hàng và PO mới xác nhận được. API kiểm tra chữ ký, hạn
token, thay đổi PO kể từ kiểm đếm, lô, tồn và quyền; sau đó nhập kho bằng transaction.
Nếu PO bị sửa/nhận thêm, token hết hạn hoặc lô hết hạn khi xác nhận, cần kiểm đếm
lại. Gửi lại token đã xác nhận không cộng tồn thêm (trùng receiptCode trả 409).
Không sửa token bằng tay. Nháp lớn quá 90000 ký tự token cần chia đợt nhỏ hơn.

### Lịch sử thanh toán trên bảng hiện có

Mở ca: POST `/api/purchases/cash-shifts` body `{ "openingCash": "0.00" }`.
Từ lúc cập nhật API này, mỗi lần thực trả > 0 tạo một CashTransaction OUT loại
SUPPLIER_PAYMENT, refDocType PURCHASE_RECEIPT, refDocId là ID phiếu nhận, có người
ghi nhận và thời gian. Áp dụng cả khoản trả ngay khi nhận và khoản trả bổ sung.
Chỉ dùng ca OPEN của chính người đang thao tác trong cửa hàng. Body có thể truyền
shiftId; nếu không truyền sẽ chọn ca OPEN mới nhất của người đó.

GET `/api/purchases/receipts/<receiptId>/payments` trả items, paidAmount,
recordedPaymentAmount, untrackedPaidAmount và historyComplete. Phiếu cũ chưa có
CashTransaction có historyComplete false; không tự dựng thời gian/người trả cho
số tiền cũ. Dữ liệu thời điểm là thời gian ghi nhận trên hệ thống. Không có cột
phương thức thanh toán riêng cho NCC trong schema hiện tại. Mỗi khoản chi phải
nằm trong giới hạn Decimal(12,2) của CashTransaction.

PATCH payment vẫn dùng **tổng đã trả**; gửi lại cùng số không tạo thêm lịch sử.
Không trừ công nợ lần nữa. Lịch sử, tổng đã trả và công nợ cập nhật cùng transaction.

### Chặn nhận lô hết hạn

Cả nhận trực tiếp, kiểm đếm nháp và xác nhận đều kiểm tra hạn sử dụng theo ngày
Việt Nam (UTC+7). Lô hết hạn trước hôm nay bị từ chối 400; ngày hết hạn đúng hôm
nay vẫn được nhận. Không có chế độ bỏ qua để nhận lô đã hết hạn. Đó là quy tắc
hiện triển khai cho yêu cầu xử lý nhận lô hết hạn.

### Đối soát công nợ

GET `/api/purchases/suppliers/<supplierId>/debt-reconciliation` trả công nợ đang lưu,
nợ tính từ phiếu RECEIVED, khoản giảm do vendor return COMPLETED, công nợ tính lại
và chênh lệch. GET không ghi dữ liệu.

```json
{
  "supplierId": "<UUID NCC>",
  "storedDebtAmount": "120000.00",
  "receiptDebtAmount": "100000.00",
  "vendorReturnCreditAmount": "0.00",
  "calculatedDebtAmount": "100000.00",
  "difference": "-20000.00",
  "applied": false
}
```

POST cùng URL để áp dụng:

```json
{ "apply": true, "expectedDebtAmount": "120000.00" }
```

expectedDebtAmount lấy từ storedDebtAmount trong preview, hỗ trợ số âm nếu NCC
đang có khoản tín dụng. Nếu đã thay đổi thì trả 409. Công thức:
sum(totalAmount - paidAmount của phiếu RECEIVED) - sum(totalReturnValue của trả NCC COMPLETED).
Không bao gồm nợ đầu kỳ/điều chỉnh ngoài chứng từ vì schema không phân tách các
nguồn đó. Chỉ áp dụng khi chấp nhận cơ sở tính này; không dùng để xóa nhầm nợ đầu kỳ.
API hiện không lưu lịch sử từng lần đối soát do chưa có bảng audit phù hợp.

### Kiểm tra bổ sung

Chạy từng lệnh riêng để mỗi suite dùng database mock độc lập:

```powershell
node --test --test-isolation=none tests/purchases-lifecycle.test.cjs
node --test --test-isolation=none tests/purchases-correction.test.cjs
node --test --test-isolation=none tests/purchases-drafts.test.cjs
node --test --test-isolation=none tests/purchases-payments.test.cjs
```

Các test không thay thế kiểm thử transaction/ràng buộc trên PostgreSQL thật.
