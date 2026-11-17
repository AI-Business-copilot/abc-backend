# Thông báo nghiệp vụ

Chuông ở CatalogHeader và AppLayout gọi API thật, không có dữ liệu mẫu hay số đếm cố định.

## Nguồn dữ liệu

- Lô hàng còn tồn bán được và hạn sử dụng còn tối đa 60 ngày, bao gồm đã hết hạn. Loại trừ lô đã cách ly/hủy. Yêu cầu `inventory.read` và `inventory.lot.read`. Ngưỡng 60 ngày / 7 ngày theo luồng trạng thái lô hiện có; ngày tính theo Asia/Ho_Chi_Minh.
- Phiếu hủy `PENDING`: yêu cầu thêm `inventory.scrap.approve`.
- Mục kiểm kê `IN_PROGRESS` được giao cho chính người đăng nhập, thuộc phiếu `IN_PROGRESS`: yêu cầu `inventory.read` và `inventory.audit.count`. Mục bị yêu cầu đếm lại phát sinh thông báo mới.

Đây là danh sách các việc/rủi ro đang hoạt động: khi dữ liệu nguồn được xử lý, thông báo tự rời danh sách. Không phải lịch sử sự kiện bất biến. Đọc thông báo không duyệt phiếu hay thay đổi nghiệp vụ. Thông báo lô chuyển sang mức cần xử lý ngay / hết hạn có ID mới để nhắc lại dù mức cũ đã đọc.

## API và lưu trữ

- `GET /api/notifications?page=1`: `{ items, total, unreadCount, page, pageSize }`; 20 mục/trang, chưa đọc trước. Số chưa đọc tính trên toàn bộ thông báo hiện còn hiệu lực và được phép xem.
- `POST /api/notifications/read`: body `{ "ids": ["..."] }`, tối đa 100 ID; trả `204`. Mỗi ID phải thuộc tập thông báo đang hoạt động mà người dùng được phép xem. Yêu cầu lại an toàn, không thay đổi thời điểm đã đọc lần đầu.
- Cả hai endpoint dùng Supabase identity và business scope hiện có. Không nhận user ID từ client. Đọc ở cửa hàng/người dùng này không ảnh hưởng người khác.
- Bảng `notification_reads` lưu khóa `(business_id, user_id, notification_id)` và `read_at`. RLS được bật; trình duyệt chỉ truy cập qua API.

FE tải khi khởi tạo, mở chuông, mỗi 30 giây khi tab hiển thị và khi quay lại tab. Không có WebSocket/push. Có phân trang, xem nguồn, đọc từng mục hoặc trang hiện tại. Lỗi API hiển thị trạng thái lỗi/thử lại, không giả làm danh sách rỗng.

## Chạy và kiểm tra

Ở backend: `npx prisma generate`, `npx prisma migrate deploy`, sau đó khởi động lại backend nếu đang chạy bản build cũ. Migration mới chỉ thêm bảng read receipts.

- Backend: `node --require ts-node/register/transpile-only --test tests/notifications.test.cjs`
- Kiểm tra database thật, chỉ đọc: `node scripts/check-notifications.cjs`
- Frontend: `npx vitest run tests/unit/notifications.test.tsx`
- Build: chạy `npm run build` trong mỗi repo.
