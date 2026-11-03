type Schema = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const uuid = { type: "string", format: "uuid" };
const day = { type: "string", format: "date" };
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const money = { type: "string", pattern: "^\\d{1,10}(\\.\\d{1,2})?$", example: "50000.00", description: "Decimal không âm, tối đa 2 số lẻ, nhỏ hơn 10 tỷ." };
const totalMoney = { ...money, pattern: "^\\d{1,12}(\\.\\d{1,2})?$", description: "Decimal không âm, tối đa 2 số lẻ, nhỏ hơn 1 nghìn tỷ." };
const quantity = { type: "integer", minimum: 1, maximum: 2147483647 };
const object = (properties: Schema, required: string[] = []): Schema => ({ type: "object", properties, required });
const lines = (schema: Schema) => ({ type: "array", minItems: 1, maxItems: 500, items: schema });
const query = (name: string, schema: Schema, required = false) => ({ name, in: "query", required, schema });
const idParameter = { name: "id", in: "path", required: true, schema: uuid, description: "ID chứng từ/NCC trong cửa hàng hiện tại." };
const paging = [query("page", { type: "integer", minimum: 1, maximum: 1000000, default: 1 }), query("pageSize", { type: "integer", minimum: 1, maximum: 100, default: 20 }), query("search", { type: "string", maxLength: 255 })];
const orderStatuses = ["ORDERED", "PARTIALLY_RECEIVED", "COMPLETED", "CLOSED_SHORT", "CANCELLED"];
const receiptStatuses = ["RECEIVED", "CANCELLED"];
const filters = (statuses: string[]) => [...paging, query("supplierId", uuid), query("status", { type: "string", enum: statuses }), query("from", day), query("to", day)];
const body = (schema: string, example?: unknown) => ({ required: true, content: { "application/json": { schema: ref(schema), ...(example ? { example } : {}) } } });
const json = (schema: Schema, description: string) => ({ description, content: { "application/json": { schema } } });
const list = (name: string) => object({ items: { type: "array", items: ref(name) }, pagination: ref("Pagination") });
const purchaseDescription = "Cần membership cửa hàng, inventory.read + finance.read. businessId được lấy từ membership; gửi businessId cửa hàng khác trả 403.";

function operation(operationId: string, tag: string, summary: string, response: Schema, options: {
  parameters?: unknown[]; requestBody?: unknown; status?: number; description?: string; write?: boolean; public?: boolean;
} = {}) {
  return {
    operationId, tags: [tag], summary,
    description: [tag.startsWith("0") && !["00. Đăng nhập", "01. Chuẩn bị và đối chiếu"].includes(tag) ? purchaseDescription : "", options.write ? "Quyền bổ sung: inventory.receive." : "", options.description].filter(Boolean).join("\n\n"),
    ...(options.public ? { security: [] } : {}),
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.requestBody ? { requestBody: options.requestBody } : {}),
    responses: {
      [options.status ?? 200]: json(response, "Thành công"),
      ...Object.fromEntries(Object.entries({ 400: "Dữ liệu đầu vào không hợp lệ", 401: "Thiếu token hoặc token hết hạn", 403: "Thiếu quyền hoặc sai cửa hàng", 404: "Không tìm thấy dữ liệu trong cửa hàng", 409: "Xung đột trạng thái, dữ liệu đã thay đổi hoặc trùng mã", 503: "Dịch vụ xác thực hoặc khóa nháp chưa sẵn sàng" }).map(([code, description]) => [code, json(ref("Error"), description)])),
    },
  };
}

const supplierTag = "02. Nhà cung cấp";
const orderTag = "03. Đơn đặt mua";
const shiftTag = "04. Ca tiền mặt";
const receiptTag = "05. Nhận hàng và nháp";
const paymentTag = "06. Thanh toán và sửa phiếu";
const debtTag = "07. Đối soát công nợ";
const prepareTag = "01. Chuẩn bị và đối chiếu";

const orderProperties = { poCode: { ...text(50), example: "PO-FO3-001" }, supplierId: uuid, orderDate: day, expectedDeliveryDate: day, items: lines(ref("OrderItemInput")) };
const receiptExample = { receiptCode: "PR-FO3-001", paidAmount: "0.00", items: [{ poItemId: "11111111-1111-4111-8111-111111111111", receivedQty: 4, actualCost: "50000.00" }] };
const schemas: Record<string, Schema> = {
  Error: object({ error: { type: "string" } }),
  Pagination: object({ page: { type: "integer" }, pageSize: { type: "integer" }, total: { type: "integer" }, totalPages: { type: "integer" } }),
  Login: object({ email: { type: "string", format: "email" }, password: { type: "string", format: "password", minLength: 1 }, gotrue_meta_security: object({ captcha_token: { type: "string", description: "Gửi nếu dự án Supabase bật CAPTCHA." } }) }, ["email", "password"]),
  Session: object({ access_token: { type: "string" }, token_type: { type: "string" }, expires_in: { type: "integer" }, refresh_token: { type: "string" }, user: { type: "object", additionalProperties: true } }),
  SupplierInput: object({ name: { ...text(255), example: "NCC FO3" }, phone: { ...text(20), example: "0901234567" }, contactPerson: { ...text(100), example: "Anh An" } }, ["name"]),
  Supplier: object({ id: uuid, name: { type: "string" }, phone: { type: "string", nullable: true }, contactPerson: { type: "string", nullable: true }, debtAmount: { type: "string", example: "100000.00" } }),
  OrderItemInput: object({ variantId: uuid, orderedQty: quantity, unitPrice: money }, ["variantId", "orderedQty", "unitPrice"]),
  OrderInput: object(orderProperties, ["poCode", "supplierId", "items"]),
  OrderUpdate: { ...object(orderProperties), minProperties: 1, additionalProperties: false },
  Order: object({ id: uuid, poCode: { type: "string" }, supplierId: uuid, status: { type: "string", enum: orderStatuses }, orderDate: day, expectedDeliveryDate: { ...day, nullable: true }, purchaseOrderItems: { type: "array", items: object({ id: uuid, variantId: uuid, orderedQty: quantity, receivedQty: { type: "integer" }, remainingQty: { type: "integer" }, unitPrice: money, subtotal: totalMoney }) }, purchaseReceipts: { type: "array", items: ref("Receipt") }, totals: object({ orderedQty: { type: "integer" }, receivedQty: { type: "integer" }, orderedAmount: totalMoney, receivedAmount: totalMoney, paidAmount: totalMoney, debtAmount: totalMoney }) }),
  ReceiptItemInput: object({ poItemId: uuid, receivedQty: quantity, actualCost: money, lotNumber: text(100), manufacturingDate: day, expirationDate: { ...day, description: "SKU quản lý lô bắt buộc số lô và hạn dùng; hạn dùng không trước hôm nay theo UTC+7. SKU không quản lý lô không gửi trường lô." } }, ["poItemId", "receivedQty", "actualCost"]),
  ReceiptInput: object({ receiptCode: { ...text(50), example: "PR-FO3-001" }, paidAmount: { ...totalMoney, default: "0.00" }, shiftId: { ...uuid, description: "Tùy chọn: ca OPEN của chính người thao tác. Trả tiền > 0 cần có ca OPEN." }, items: lines(ref("ReceiptItemInput")) }, ["receiptCode", "items"]),
  Receipt: object({ id: uuid, receiptCode: { type: "string" }, poId: uuid, supplierId: uuid, status: { type: "string", enum: receiptStatuses }, receivedAt: { type: "string", format: "date-time" }, totalAmount: totalMoney, paidAmount: totalMoney, debtAmount: totalMoney, purchaseReceiptItems: { type: "array", items: object({ id: uuid, poItemId: uuid, variantId: uuid, lotId: { ...uuid, nullable: true }, receivedQty: quantity, actualCost: money, subtotal: totalMoney, lot: { type: "object", nullable: true, additionalProperties: true }, poItem: { type: "object", additionalProperties: true }, inventoryLedger: { type: "array", items: { type: "object", additionalProperties: true } } }) } }),
  Draft: object({ status: { type: "string", enum: ["DRAFT"] }, persisted: { type: "boolean", enum: [false] }, draftToken: { type: "string" }, expiresAt: { type: "string", format: "date-time" }, receipt: { type: "object", additionalProperties: true }, totalAmount: totalMoney, debtAmount: totalMoney }),
  ConfirmDraft: object({ draftToken: { type: "string", minLength: 1, maxLength: 90000 } }, ["draftToken"]),
  PaymentInput: object({ paidAmount: { ...totalMoney, description: "TỔNG đã trả mới, không phải phần trả thêm. Không được giảm hoặc vượt tổng phiếu." }, shiftId: uuid }, ["paidAmount"]),
  CorrectionInput: object({ expectedTotalAmount: totalMoney, items: lines(object({ id: { ...uuid, description: "PurchaseReceiptItem.id, không phải poItemId." }, expectedReceivedQty: quantity, expectedActualCost: money, receivedQty: quantity, actualCost: money }, ["id", "expectedReceivedQty", "expectedActualCost", "receivedQty", "actualCost"])) }, ["expectedTotalAmount", "items"]),
  ShiftInput: object({ openingCash: { ...money, default: "0.00" } }),
  Shift: object({ id: uuid, userId: uuid, status: { type: "string", enum: ["OPEN", "CLOSED"] }, openingCash: money, openedAt: { type: "string", format: "date-time" } }),
  PaymentHistory: object({ receiptId: uuid, paidAmount: totalMoney, recordedPaymentAmount: totalMoney, untrackedPaidAmount: totalMoney, historyComplete: { type: "boolean" }, items: { type: "array", items: { type: "object", additionalProperties: true } } }),
  ReconcileInput: object({ apply: { type: "boolean", enum: [true] }, expectedDebtAmount: { type: "string", pattern: "^-?\\d{1,10}(\\.\\d{1,2})?$", example: "120000.00", description: "storedDebtAmount từ lần GET preview gần nhất; có thể âm." } }, ["apply", "expectedDebtAmount"]),
  Reconciliation: object({ supplierId: uuid, storedDebtAmount: { type: "string" }, receiptDebtAmount: { type: "string" }, vendorReturnCreditAmount: { type: "string" }, calculatedDebtAmount: { type: "string" }, difference: { type: "string" }, applied: { type: "boolean" }, basis: { type: "string" } }),
};

/** Runtime config only includes the public anon key, never the service-role key. */
export function createFo3Document() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  return {
    openapi: "3.0.3",
    info: {
      title: "fo3", version: "1.0.0",
      description: `Swagger riêng cho F03: đặt mua, nhận hàng và thanh toán NCC.\n\n1. Mở POST /auth/v1/token, Try it out, nhập email/password rồi Execute. Swagger tự Authorize bằng access_token. Có thể dán token từ frontend vào nút Authorize.\n2. GET /auth/me để kiểm tra cửa hàng/quyền.\n3. Lấy SKU → tạo NCC → tạo PO → mở ca nếu trả tiền → nhận hàng → thanh toán → đối chiếu kho/nợ.\n\nThay các UUID mẫu bằng ID thật từ response trước; dùng mã PO/phiếu mới mỗi lần test. Tiền gửi bằng chuỗi decimal. Query ngày from/to bao gồm cả hai ngày theo UTC. Token chỉ giữ trong bộ nhớ trang, tải lại cần đăng nhập lại.${!supabaseUrl || !anonKey ? "\n\nChưa cấu hình SUPABASE_URL/SUPABASE_ANON_KEY trên backend: đăng nhập trực tiếp chưa sẵn sàng." : ""}`,
    },
    servers: [{ url: "/api", description: "Backend hiện tại" }],
    security: [{ bearerAuth: [] }],
    tags: ["00. Đăng nhập", prepareTag, supplierTag, orderTag, shiftTag, receiptTag, paymentTag, debtTag].map((name) => ({ name })),
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } }, schemas },
    paths: {
      ...(supabaseUrl && anonKey ? {
        "/auth/v1/token": {
          post: {
            ...operation("fo3Login", "00. Đăng nhập", "Đăng nhập email/mật khẩu Supabase", ref("Session"), { public: true, requestBody: body("Login", { email: "your-email@example.com", password: "" }), description: "Dùng tài khoản đã tồn tại. Khi thành công Swagger tự gắn Bearer token cho các API backend. Nếu dùng Google, lấy access token từ frontend rồi dán vào Authorize." }),
            servers: [{ url: new URL(supabaseUrl).origin }],
            parameters: [query("grant_type", { type: "string", enum: ["password"], default: "password" }, true), { name: "apikey", in: "header", required: true, schema: { type: "string", default: anonKey }, description: "Public anon key của Supabase (được điền sẵn)." }],
          },
        },
      } : {}),
      "/health": { get: operation("fo3Health", prepareTag, "Kiểm tra server", object({ status: { type: "string" } }), { public: true }) },
      "/auth/me": { get: operation("fo3Me", "00. Đăng nhập", "Kiểm tra tài khoản, cửa hàng và quyền", object({ user: { type: "object", additionalProperties: true }, business: { type: "object", nullable: true, additionalProperties: true }, permissions: { type: "array", items: { type: "string" } }, platformRoles: { type: "array", items: { type: "string" } }, onboardingRequired: { type: "boolean" } })) },
      "/inventory/variants": { get: operation("fo3Variants", prepareTag, "Tìm SKU, tồn và giá vốn", { type: "object", additionalProperties: true }, { parameters: [query("search", { type: "string" }), query("categoryId", uuid), query("limit", { type: "integer", default: 20 })], description: "Cần inventory.read. Lấy ID SKU đang hoạt động để tạo PO." }) },
      "/inventory/lots": { get: operation("fo3Lots", prepareTag, "Xem lô và tồn theo SKU", { type: "object", additionalProperties: true }, { parameters: [query("variantId", uuid, true)], description: "Cần inventory.read." }) },
      "/inventory/ledger": { get: operation("fo3Ledger", prepareTag, "Đối chiếu lịch sử nhập và điều chỉnh kho", { type: "object", additionalProperties: true }, { parameters: [...paging, query("type", { type: "string" }), query("from", day), query("to", day)], description: "Cần inventory.read. Ledger là lịch sử, không phải tồn hiện tại." }) },
      "/purchases/suppliers": {
        get: operation("fo3Suppliers", supplierTag, "Danh sách NCC và công nợ", list("Supplier"), { parameters: paging }),
        post: operation("fo3CreateSupplier", supplierTag, "Tạo NCC", ref("Supplier"), { status: 201, write: true, requestBody: body("SupplierInput") }),
      },
      "/purchases/orders": {
        get: operation("fo3Orders", orderTag, "Danh sách PO, SKU, đợt nhận và totals", list("Order"), { parameters: filters(orderStatuses) }),
        post: operation("fo3CreateOrder", orderTag, "Tạo PO ở trạng thái ORDERED", ref("Order"), { status: 201, write: true, requestBody: body("OrderInput", { poCode: "PO-FO3-001", supplierId: "11111111-1111-4111-8111-111111111111", items: [{ variantId: "22222222-2222-4222-8222-222222222222", orderedQty: 10, unitPrice: "50000.00" }] }), description: "Không lặp SKU. Tạo PO chưa làm thay đổi tồn kho/công nợ." }),
      },
      "/purchases/orders/{id}": {
        get: operation("fo3Order", orderTag, "Chi tiết PO", ref("Order"), { parameters: [idParameter] }),
        patch: operation("fo3UpdateOrder", orderTag, "Sửa PO chưa có phiếu nhận", ref("Order"), { parameters: [idParameter], write: true, requestBody: body("OrderUpdate", { items: [{ variantId: "22222222-2222-4222-8222-222222222222", orderedQty: 12, unitPrice: "49000.00" }] }), description: "Chỉ PO ORDERED chưa từng có phiếu nhận. Gửi items sẽ thay toàn bộ danh sách." }),
      },
      "/purchases/orders/{id}/cancel": { post: operation("fo3CancelOrder", orderTag, "Hủy PO chưa nhận", ref("Order"), { parameters: [idParameter], write: true, description: "Không cần body. Gửi lại sau thành công trả PO CANCELLED, không ghi thêm." }) },
      "/purchases/orders/{id}/close": { post: operation("fo3CloseOrder", orderTag, "Đóng phần giao thiếu", ref("Order"), { parameters: [idParameter], write: true, description: "Không cần body. Chỉ PO đã nhận một phần và còn thiếu; thành CLOSED_SHORT." }) },
      "/purchases/orders/{id}/receipts": { post: operation("fo3ReceiveOrder", receiptTag, "Nhận hàng ngay và nhập kho", ref("Receipt"), { status: 201, parameters: [idParameter], write: true, requestBody: body("ReceiptInput", receiptExample), description: "Cộng tồn, cập nhật giá vốn, công nợ và khoản chi trong cùng transaction. Có thể lặp poItemId để chia lô, tổng lượng không vượt phần còn thiếu." }) },
      "/purchases/orders/{id}/receipt-drafts": { post: operation("fo3PreviewReceipt", receiptTag, "Kiểm đếm nháp, chưa ghi dữ liệu", ref("Draft"), { status: 201, parameters: [idParameter], write: true, requestBody: body("ReceiptInput", receiptExample), description: "Token nháp sống 1 giờ, client tự giữ; không giữ chỗ mã/lượng. Cần PURCHASE_DRAFT_SECRET ít nhất 32 ký tự trên backend, nếu thiếu trả 503." }) },
      "/purchases/orders/{id}/receipt-drafts/confirm": { post: operation("fo3ConfirmReceipt", receiptTag, "Xác nhận token nháp và nhập kho", ref("Receipt"), { status: 201, parameters: [idParameter], write: true, requestBody: body("ConfirmDraft"), description: "Kiểm tra lại PO và điều kiện nhận trong transaction. PO thay đổi hoặc token hết hạn trả 409, cần preview lại." }) },
      "/purchases/receipts": { get: operation("fo3Receipts", receiptTag, "Danh sách phiếu nhận", list("Receipt"), { parameters: [...filters(receiptStatuses), query("poId", uuid)] }) },
      "/purchases/receipts/{id}": { get: operation("fo3Receipt", receiptTag, "Chi tiết phiếu, SKU/lô/PO và ledger", ref("Receipt"), { parameters: [idParameter] }) },
      "/purchases/receipts/{id}/payment": { patch: operation("fo3UpdatePayment", paymentTag, "Cập nhật tổng đã trả NCC", ref("Receipt"), { parameters: [idParameter], write: true, requestBody: body("PaymentInput", { paidAmount: "150000.00" }), description: "Gửi TỔNG đã trả. Khoản chi mới = tổng mới − tổng cũ. Cùng tổng không tạo thêm khoản chi. Trả thêm cần ca OPEN." }) },
      "/purchases/receipts/{id}/payments": { get: operation("fo3PaymentHistory", paymentTag, "Lịch sử các khoản chi cho phiếu", ref("PaymentHistory"), { parameters: [idParameter] }) },
      "/purchases/receipts/{id}/items": { patch: operation("fo3CorrectReceipt", paymentTag, "Sửa lượng/giá phiếu đã nhận", ref("Receipt"), { parameters: [idParameter], write: true, requestBody: body("CorrectionInput", { expectedTotalAmount: "200000.00", items: [{ id: "11111111-1111-4111-8111-111111111111", expectedReceivedQty: 4, expectedActualCost: "50000.00", receivedQty: 3, actualCost: "49000.00" }] }), description: "Cần thêm inventory.adjust. Dùng expected từ phiếu hiện tại; chưa có giao dịch kho tiếp theo trên SKU. Chỉ gửi dòng sửa; không thêm/xóa dòng hoặc đổi SKU/lô. Dữ liệu cũ không khớp trả 409." }) },
      "/purchases/cash-shifts": { post: operation("fo3OpenShift", shiftTag, "Mở hoặc lấy ca OPEN của chính người thao tác", ref("Shift"), { write: true, requestBody: { ...body("ShiftInput", { openingCash: "0.00" }), required: false }, description: "Trả 200 kể cả khi mở ca mới. Gửi lại trả ca đang OPEN, không cộng thêm openingCash." }) },
      "/purchases/cash-shifts/current": { get: operation("fo3CurrentShift", shiftTag, "Ca OPEN hiện tại hoặc null", { ...schemas.Shift, nullable: true }) },
      "/purchases/suppliers/{id}/debt-reconciliation": {
        get: operation("fo3PreviewDebt", debtTag, "Preview công nợ tính lại, không ghi dữ liệu", ref("Reconciliation"), { parameters: [idParameter], description: "Công nợ = nợ phiếu RECEIVED − giá trị trả NCC COMPLETED. Không gồm nợ đầu kỳ/điều chỉnh ngoài chứng từ." }),
        post: operation("fo3ApplyDebt", debtTag, "Áp dụng công nợ từ chứng từ", ref("Reconciliation"), { parameters: [idParameter], write: true, requestBody: body("ReconcileInput"), description: "Lấy expectedDebtAmount từ storedDebtAmount ở GET preview. Nợ thay đổi sau preview trả 409. Response báo storedDebtAmount/difference trước áp dụng." }),
      },
    },
  };
}
