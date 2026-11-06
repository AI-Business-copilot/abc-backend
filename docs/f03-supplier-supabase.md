# Cập nhật F03 Supplier lên Supabase

Phạm vi: thêm `supplier_products`, 7 trường hồ sơ vào `suppliers`, unique/FK cùng cửa hàng, CHECK và index NCC ưu tiên. Không tạo các bảng mở rộng ở mục 5 của bản nháp.

Migration: `prisma/migrations/20261104090000_f03_supplier_catalog/migration.sql`.

## 1. Cấu hình kết nối

Trong Supabase Dashboard, chọn đúng project → **Connect** → lấy URI **Direct connection**. Nếu máy không hỗ trợ IPv6, dùng **Session pooler**, cổng 5432. Dùng đúng username/host Dashboard cung cấp; không dùng Transaction pooler cổng 6543 cho migration.

Điền trong `abc-backend/.env` (không commit mật khẩu):

```dotenv
DIRECT_URL="postgresql://<USER>:<URL_ENCODED_PASSWORD>@<HOST>:5432/postgres?sslmode=require"
```

`prisma.config.ts` đã ưu tiên `DIRECT_URL` cho CLI. Giữ `DATABASE_URL` hiện có cho backend.

CLI mặc định thêm `connect_timeout=30` nếu URL chưa cấu hình thời gian chờ. Khi gặp P1001 chập chờn, thời gian chờ này giúp tránh ngắt kết nối quá sớm; không khắc phục được host sai hoặc mạng bị chặn. Giá trị `connect_timeout` có sẵn trên URL vẫn được giữ nguyên.

## 2. Kiểm tra trước khi áp dụng

Chạy trong thư mục `abc-backend`:

```powershell
npx prisma validate
npx prisma migrate status
```

Trong Supabase SQL Editor, chạy truy vấn chỉ đọc:

```sql
SELECT to_regclass('public.supplier_products') AS existing_catalog;

SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('suppliers', 'supplier_products')
ORDER BY table_name, ordinal_position;
```

Bản nháp phát hiện tài liệu cũ nhắc tới migration `20261103090000_supplier_products` nhưng file không có trong checkout. Nếu DB đã có `supplier_products`, có các cột mới hoặc có migration thất bại, cần đối chiếu trước; không chạy migration tạo bảng này chồng lên cấu trúc cũ. `migrate status` kiểm tra lịch sử, không chứng minh schema thực tế đã khớp.

Nếu chỉ thiếu file local của migration đã chạy thành công trên DB, `migrate status` vẫn báo lệch lịch sử. Điều này không tự chặn `migrate deploy`: lệnh deploy áp dụng các migration local chưa chạy. Vẫn cần khôi phục SQL gốc để lịch sử đầy đủ và hỗ trợ môi trường phát triển; không tạo file rỗng hoặc xóa bản ghi DB để làm hết cảnh báo.

## 3. Áp dụng bằng Prisma

Khi đã đối chiếu cấu trúc DB với SQL F03, không có migration thất bại và xác nhận danh sách pending chỉ gồm những thay đổi muốn áp dụng:

```powershell
npx prisma migrate deploy
npx prisma generate
npx prisma migrate status
npm run build
```

`migrate deploy` chạy **tất cả migration pending**. Đọc danh sách ở bước 2 để biết những thay đổi nào sẽ được áp dụng. Không dùng `migrate reset` hoặc `migrate dev` trên DB Supabase đang có dữ liệu cần giữ.

Kiểm tra ngày 05/11/2026: trên DB được cấu hình lúc kiểm tra, F03 là migration local duy nhất pending; bảng `supplier_products` và 7 cột mới trên `suppliers` chưa tồn tại; không có migration thất bại. Ba migration DB có nhưng local thiếu là `20261104120000_product_lot_items`, `20261104130000_product_lot_items_indexes_and_view`, `20261104140000_stock_audit_status_done`. Đã fetch origin nhưng chưa tìm được SQL gốc. Migration đã chạy `20261029015517_add_lot_status` cũng có checksum khác file local (đã kiểm tra cả LF/CRLF), cần đối chiếu bản gốc. Các vấn đề lịch sử này không được tự sửa bằng cách sửa bảng `_prisma_migrations`. Chạy lại kiểm tra nếu DB đã thay đổi sau thời điểm này.

## 4. Nếu áp dụng riêng F03 qua SQL Editor

Chỉ dùng cách này khi đã đối chiếu bước 2 và xác nhận các migration trước F03 đã được áp dụng. Mở file SQL của migration ở trên, dán **toàn bộ** vào SQL Editor của đúng project và chạy. File có `BEGIN`/`COMMIT`, nên lỗi trong một bước sẽ rollback transaction.

Sau khi SQL chạy thành công, ghi nhận đúng migration đó để Prisma không chạy lại:

```powershell
npx prisma migrate resolve --applied 20261104090000_f03_supplier_catalog
npx prisma generate
npx prisma migrate status
npm run build
```

Không chạy `resolve --applied` nếu SQL chưa thành công hoặc chưa xác minh đầy đủ cấu trúc. Sau đó khởi động lại backend.

## Giới hạn của thay đổi này

Đây là cập nhật schema/migration, chưa triển khai toàn bộ quy tắc API/UI trong bản nháp. Service hiện tại vẫn xóa thật liên kết, chưa lọc trạng thái hoạt động hoặc kiểm tra MOQ/bội số khi tạo PO. `priceUpdatedAt` có mặc định khi tạo; service cần chủ động cập nhật nó mỗi lần xác nhận giá. `updatedAt` được Prisma cập nhật khi ghi qua client; SQL trực tiếp phải tự cập nhật trường này.

Bảng mới bật RLS và không thêm policy truy cập trực tiếp từ frontend. Backend cần kết nối bằng role thích hợp như kiến trúc hiện tại; role không có quyền bypass RLS cần policy riêng.

Tài liệu chính thức: [Supabase + Prisma](https://supabase.com/docs/guides/database/prisma), [Prisma migrate deploy](https://docs.prisma.io/docs/cli/v7/migrate/deploy).
