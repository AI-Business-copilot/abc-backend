# Backend tests

```powershell
npm test
npm run test:unit
npm run test:contracts
```

`npm test` chạy unit/service test với mock và Swagger contract test cục bộ. `test:unit` loại các test Swagger. Hai nhóm đều không chọn `tests/*postgres*.test.cjs` và workflow `src/tests/f05_f06_returns.test.ts` dùng database thật. Test phân quyền ở `src/tests/business-role-policy.test.ts` được chọn rõ ràng.

Test mới dùng mock đặt trong `tests/*.test.cjs`. Mỗi file chạy trong tiến trình Node riêng để tránh xung đột `require.cache` giữa các database mock. Không đưa integration test cần dữ liệu thật vào mẫu này; tách thành nhóm `.postgres.test.cjs` hoặc runner integration riêng.

Kiểm tra TypeScript bằng `npx tsc --noEmit`. Nếu schema Prisma thay đổi, chạy `npm run prisma:generate` trước. Không cần migration để chạy unit test.
