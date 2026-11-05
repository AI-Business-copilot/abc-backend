import { createFo3Document } from "./fo3.openapi";

type Schema = Record<string, unknown>;
const uuid = { type: "string", format: "uuid" };
const money = { type: "string", pattern: "^\\d{1,10}(\\.\\d{1,2})?$", example: "100000.00" };
const object = (properties: Schema, required: string[] = []) => ({ type: "object", properties, required });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const query = (name: string, schema: Schema) => ({ name, in: "query", schema });
const paging = [query("page", { type: "integer", minimum: 1, maximum: 1000000, default: 1 }), query("pageSize", { type: "integer", minimum: 1, maximum: 100, default: 20 }), query("search", { type: "string", maxLength: 255 })];
const id = [{ name: "id", in: "path", required: true, schema: uuid }];
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
function op(operationId: string, tag: string, summary: string, response: Schema, options: { input?: string; parameters?: unknown[]; status?: number; write?: boolean } = {}) {
  return { operationId, tags: [tag], summary,
    description: `Cần orders.read${options.write ? " + orders.create" : ""}. Cửa hàng lấy từ membership.`,
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.input ? { requestBody: { required: true, content: { "application/json": { schema: ref(options.input) } } } } : {}),
    responses: {
      [options.status ?? 200]: { description: "Thành công", content: { "application/json": { schema: response } } },
      ...Object.fromEntries(Object.entries({ 400: "Dữ liệu không hợp lệ", 401: "Thiếu hoặc sai token", 403: "Thiếu quyền hoặc sai cửa hàng/người thao tác", 404: "Không tìm thấy", 409: "Thiếu tồn, khóa kiểm kê, ca đóng, trùng mã hoặc đơn đã xử lý" }).map(([code, description]) => [code, { description, content: { "application/json": { schema: ref("Error") } } }])),
    },
  };
}

export function createFo4Document() {
  const base = createFo3Document();
  const prepare: Record<string, unknown> = {};
  for (const path of ["/auth/v1/token", "/auth/me", "/health", "/inventory/variants", "/inventory/lots", "/inventory/ledger"]) {
    const source = (base.paths as Record<string, any>)[path];
    if (source) {
      const copy = JSON.parse(JSON.stringify(source));
      for (const method of Object.values(copy) as any[]) {
        method.operationId = method.operationId.replace("fo3", "fo4");
        method.tags = [path.startsWith("/auth") ? "00. Đăng nhập" : "01. Chuẩn bị và đối chiếu"];
        method.summary = ({ "/auth/v1/token": "Đăng nhập email/password Supabase", "/auth/me": "Kiểm tra tài khoản, cửa hàng và quyền", "/health": "Kiểm tra server", "/inventory/variants": "Tìm SKU và tồn kho", "/inventory/lots": "Xem lô và hạn dùng", "/inventory/ledger": "Đối chiếu lịch sử kho" } as Record<string, string>)[path];
        method.description = path === "/auth/v1/token" ? "Dùng tài khoản hiện có. Swagger tự Authorize access_token khi đăng nhập thành công. Có thể dán access token từ frontend vào Authorize." : "API chuẩn bị và đối chiếu F04.";
        if (path.startsWith("/inventory")) method.description = "Cần inventory.read. Lấy SKU, tồn và lịch sử để kiểm tra F04.";
      }
      prepare[path] = copy;
    }
  }
  const schemas: Record<string, Schema> = {};
  for (const name of ["Login", "Session", "Error", "Pagination", "ShiftInput", "Shift"]) schemas[name] = base.components.schemas[name];
  const customer = "02. Khách hàng", shift = "03. Ca bán hàng", order = "04. Đơn bán", payment = "05. Xác nhận thanh toán";
  Object.assign(schemas, {
    CustomerInput: object({ name: { ...text(150), example: "Khách F04" }, phone: { ...text(20), example: "0901234567" } }, ["name", "phone"]),
    Customer: object({ id: uuid, name: text(150), phone: text(20), businessId: uuid }),
    OrderInput: object({ orderCode: { ...text(50), example: "POS-F04-001" }, shiftId: uuid, customerId: uuid, items: { type: "array", minItems: 1, maxItems: 500, items: object({ variantId: uuid, quantity: { type: "integer", minimum: 1, maximum: 2147483647 } }, ["variantId", "quantity"]) } }, ["orderCode", "items"]),
    PaymentInput: object({ confirmed: { type: "boolean", enum: [true], description: "Chỉ gửi true sau khi đã kiểm tra nhận đủ tiền thực tế." }, paymentMethod: { type: "string", enum: ["CASH", "BANK_TRANSFER"] }, amount: money, paymentReference: text(100) }, ["confirmed", "paymentMethod", "amount"]),
    OrderItem: object({ id: uuid, variantId: uuid, lotId: { ...uuid, nullable: true }, quantity: { type: "integer" }, unitPrice: money, unitCost: money, subtotal: money, lot: { type: "object", nullable: true, additionalProperties: true } }),
    Payment: object({ id: uuid, orderId: uuid, shiftId: uuid, paymentMethod: { type: "string", enum: ["CASH", "BANK_TRANSFER"] }, amount: money, paymentReference: { type: "string", nullable: true }, createdAt: { type: "string", format: "date-time" } }),
    Order: object({ id: uuid, businessId: uuid, shiftId: uuid, cashierId: uuid, orderCode: text(50), customerId: { ...uuid, nullable: true }, status: { type: "string", enum: ["DRAFT", "COMPLETED", "CANCELLED"] }, totalGrossAmount: money, totalNetAmount: money, discountAmount: money, totalCogsAmount: money, grossProfit: { type: "string", description: "Có thể âm khi bán dưới giá vốn." }, customer: { type: "object", nullable: true, additionalProperties: true }, orderItems: { type: "array", items: ref("OrderItem") }, orderPayments: { type: "array", items: ref("Payment") } }),
    OrderDetail: { allOf: [ref("Order"), object({ inventoryLedger: { type: "array", items: { type: "object", additionalProperties: true } } })] },
    Orders: object({ items: { type: "array", items: ref("Order") }, pagination: ref("Pagination") }),
    Customers: object({ items: { type: "array", items: ref("Customer") }, pagination: ref("Pagination") }),
  });
  return {
    openapi: "3.0.3", info: { title: "fo4", version: "1.0.0", description: "F04 — Bán hàng tại quầy và thanh toán. Đăng nhập → lấy SKU → mở ca → tạo đơn DRAFT → xác nhận đã nhận đủ tiền → đối chiếu đơn/kho/ledger. Giá bán lấy từ ProductVariants.basePrice. Đơn nháp không giữ chỗ hoặc giảm tồn; FEFO được kiểm tra lại khi thanh toán. Lô hết hạn trước hôm nay UTC+7 và hàng hỏng không được bán. Thanh toán là xác nhận thủ công của người bán, chưa tích hợp ngân hàng/webhook. Chỉ hỗ trợ trả đủ một lần, tiền mặt hoặc chuyển khoản; không chiết khấu/hoàn tiền/đóng ca. Token chỉ lưu trong bộ nhớ trang. Swagger chuẩn bị/đối chiếu kho cần thêm inventory.read." },
    servers: [{ url: "/api" }], security: [{ bearerAuth: [] }], components: { securitySchemes: base.components.securitySchemes, schemas },
    tags: ["00. Đăng nhập", "01. Chuẩn bị và đối chiếu", customer, shift, order, payment].map(name => ({ name })),
    paths: {
      ...prepare,
      "/sales/customers": { get: op("fo4Customers", customer, "Tìm khách hàng", ref("Customers"), { parameters: paging }), post: op("fo4CreateCustomer", customer, "Tạo khách hàng (tùy chọn)", ref("Customer"), { input: "CustomerInput", write: true, status: 201 }) },
      "/sales/cash-shifts/current": { get: op("fo4CurrentShift", shift, "Ca OPEN của chính người thao tác hoặc null", { ...ref("Shift"), nullable: true }) },
      "/sales/cash-shifts": { post: op("fo4OpenShift", shift, "Mở ca hoặc dùng lại ca OPEN hiện có", ref("Shift"), { input: "ShiftInput", write: true }) },
      "/sales/orders": { get: op("fo4Orders", order, "Danh sách đơn bán", ref("Orders"), { parameters: [...paging, query("status", { type: "string", enum: ["DRAFT", "COMPLETED", "CANCELLED"] }), query("from", { type: "string", format: "date" }), query("to", { type: "string", format: "date" })] }), post: op("fo4CreateOrder", order, "Tạo đơn nháp, kiểm tra tồn, chưa trừ kho", ref("Order"), { input: "OrderInput", write: true, status: 201 }) },
      "/sales/orders/{id}": { get: op("fo4Order", order, "Chi tiết đơn, thanh toán và ledger xuất bán", ref("OrderDetail"), { parameters: id }) },
      "/sales/orders/{id}/payments": { post: op("fo4Pay", payment, "Xác nhận thu đủ tiền, FEFO và hoàn tất đơn", ref("Order"), { input: "PaymentInput", parameters: id, write: true }) },
      "/sales/orders/{id}/cancel": { post: op("fo4Cancel", order, "Hủy đơn nháp chưa thanh toán", ref("Order"), { parameters: id, write: true }) },
    },
  };
}
