# Tự điền hồ sơ và nhập hàng nhà cung cấp

## Tra cứu mã số thuế

Trong biểu mẫu thêm/sửa NCC, nhập đủ MST 10 số, 12 số hoặc MST chi nhánh 10-3 số. Sau 800 ms, hệ thống gọi backend để lấy tên và địa chỉ. Kết quả chỉ điền vào biểu mẫu; người dùng kiểm tra rồi lưu. Khi người dùng sửa tên/địa chỉ trong lúc chờ, trường đã sửa được giữ lại. Có nút thử lại; khi dịch vụ lỗi vẫn có thể nhập thủ công.

Backend dùng Casso Open Platform, không dùng API VietQR cũ sắp dừng. Cấu hình server:

```
CASSO_APP_ID=...
CASSO_APP_SECRET=...
```

Tạo app tại https://open.casso.vn, cấp scope `idkit:business:read` và `idkit:household:read` nếu tra hộ kinh doanh. Không đưa secret vào biến `VITE_*`. Khởi động lại backend sau khi cấu hình. Tài liệu nguồn: https://www.vietqr.io/tra-cuu-mst.

Endpoint: `GET /api/purchases/suppliers/tax-lookup?taxCode=...`. Có xác thực, phạm vi doanh nghiệp và quyền như chức năng NCC; yêu cầu thêm `inventory.receive`. Chỉ lấy tên và địa chỉ, không suy diễn trạng thái hợp tác nội bộ từ trạng thái thuế. Token được cache trong bộ nhớ, timeout mỗi request 10 giây, thử cấp lại token một lần khi hết hạn.

## Nhập danh mục sản phẩm NCC

Mở **Nhà cung cấp → Sản phẩm → Nhập Excel / CSV**. Tài khoản cần `inventory.receive` và `products.manage` bên cạnh quyền đọc của phân hệ mua hàng. NCC phải đang hợp tác.

- Hỗ trợ `.xlsx` và CSV UTF-8 dấu phẩy/chấm phẩy; file tối đa 5 MB, 500 dòng sản phẩm, 100 cột.
- Đọc trang tính đầu tiên, tiêu đề ở dòng 1. Không hỗ trợ `.xls`, ảnh hoặc PDF.
- Tự nhận diện tiêu đề phổ biến; có thể chọn lại cột trước khi xem trước.
- Cần SKU nội bộ, tên sản phẩm, giá chào. Tùy chọn mã hàng NCC và đơn vị tính (mặc định Cái).
- SKU nên định dạng Text trong Excel để giữ số 0 đầu. Giá dùng số thuần không có dấu phân cách hàng nghìn, tối đa 2 chữ số thập phân.
- Ô công thức/ngày/liên kết ở cột được chọn bị từ chối; dán giá trị trước khi tải lên.
- SKU nội bộ đã tồn tại: liên kết với NCC hoặc cập nhật giá chào, mã/tên hàng NCC. Không đổi tên, giá vốn, giá bán hay tồn kho nội bộ. Các điều kiện đặt mua/ưu tiên hiện có được giữ.
- SKU mới: tạo sản phẩm/biến thể rồi liên kết NCC. Giá bán và giá vốn ban đầu 0; tồn kho vẫn 0. Cần thiết lập giá bán trước khi bán. Không tạo phiếu nhập kho hay công nợ từ file báo giá.
- Trùng SKU trong cùng file, giá sai, SKU đã ngừng hoặc tên sản phẩm xung đột thiết lập sẽ chặn toàn bộ file.
- Xem trước không ghi dữ liệu. Nhập chính thức chạy trong một transaction, kiểm tra lại file và trạng thái danh mục bằng digest; thay đổi sau xem trước sẽ yêu cầu xem lại. Nhập lại file với cùng SKU cập nhật liên kết hiện có, không tạo sản phẩm lặp.
- Khi xác nhận, backend tạo các mẫu sản phẩm còn thiếu và SKU mới theo lô, rồi thêm/cập nhật toàn bộ liên kết NCC bằng một lệnh PostgreSQL có tham số. Các mẫu trùng tên dùng chung một hồ sơ; kết quả được ghép bằng tên/SKU thay vì thứ tự database trả về. Không ghi tuần tự từng dòng hay mở nhiều transaction song song. Nếu một bước lỗi, toàn bộ lô được hoàn tác; các thiết lập đặt mua, ưu tiên NCC và ghi chú hiện có được giữ lại.

Endpoints multipart (`file`, `mapping` JSON tùy chọn; xác nhận có thêm `digest`):

```
POST /api/purchases/suppliers/:id/products/import/preview
POST /api/purchases/suppliers/:id/products/import/confirm
```

Không cần thay đổi schema. Bảng `supplier_products` của chức năng hiện tại cần được triển khai trước. Không lưu file gốc.

## Kiểm tra

```
node tests/supplier-import.test.cjs
node tests/supplier-tax.test.cjs
node tests/supplier-products.test.cjs
npm run build
```

Các bài kiểm tra backend mặc định dùng DB/API giả lập, không thay thế kiểm thử kết nối Casso thật và cơ sở dữ liệu triển khai.

Kiểm thử câu lệnh ghi theo lô trên PostgreSQL thật: đặt `SUPPLIER_IMPORT_TEST_DATABASE_URL`, sau đó chạy `node tests/supplier-import.postgres.test.cjs`. Bài kiểm tra dùng bảng tạm trong một kết nối riêng và rollback khi kết thúc, không ghi vào bảng sản phẩm đang sử dụng. Kiểm tra 500 dòng, phạm vi cửa hàng, giá chính xác, giữ nguyên thiết lập NCC và hoàn tác khi dữ liệu vi phạm ràng buộc.
