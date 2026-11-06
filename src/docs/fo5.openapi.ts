import { createFo3Document } from "./fo3.openapi";

type Schema = Record<string, unknown>;
const uuid = { type: "string", format: "uuid" };
const money = { type: "string", pattern: "^\\d{1,10}(\\.\\d{1,2})?$", example: "100000.00" };
const object = (properties: Schema, required: string[] = []) => ({ type: "object", properties, required });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const query = (name: string, schema: Schema) => ({ name, in: "query", schema });
const paging = [
  query("page", { type: "integer", minimum: 1, maximum: 1000000, default: 1 }),
  query("pageSize", { type: "integer", minimum: 1, maximum: 100, default: 20 }),
  query("search", { type: "string", maxLength: 255 }),
];
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });

function op(
  operationId: string,
  tag: string,
  summary: string,
  response: Schema,
  options: { input?: string; parameters?: unknown[]; status?: number; write?: boolean; description?: string } = {}
) {
  return {
    operationId,
    tags: [tag],
    summary,
    description: options.description || `Cần token hợp lệ và membership cửa hàng.${options.write ? " Cần quyền ghi." : ""}`,
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.input ? { requestBody: { required: true, content: { "application/json": { schema: ref(options.input) } } } } : {}),
    responses: {
      [options.status ?? 200]: { description: "Thành công", content: { "application/json": { schema: response } } },
      ...Object.fromEntries(
        Object.entries({
          400: "Dữ liệu không hợp lệ",
          401: "Thiếu hoặc sai token",
          403: "Thiếu quyền (STAFF bị cấm tạo F06 và trả không hóa đơn F05)",
          404: "Không tìm thấy dữ liệu trong cửa hàng",
          409: "Khóa kiểm kê F07, chưa mở ca F09, trả vượt số lượng mua F04 hoặc thiếu tồn kho",
        }).map(([code, description]) => [code, { description, content: { "application/json": { schema: ref("Error") } } }])
      ),
    },
  };
}

export function createFo5Document() {
  const base = createFo3Document();
  const prepare: Record<string, unknown> = {};

  for (const path of [
    "/auth/v1/token",
    "/auth/me",
    "/health",
    "/inventory/variants",
    "/inventory/lots",
    "/inventory/ledger",
    "/sales/cash-shifts/current",
  ]) {
    const source = (base.paths as Record<string, any>)[path];
    if (source) {
      const copy = JSON.parse(JSON.stringify(source));
      for (const method of Object.values(copy) as any[]) {
        method.operationId = method.operationId.replace("fo3", "fo5");
        method.tags = [path.startsWith("/auth") ? "00. Đăng nhập" : "01. Chuẩn bị và đối chiếu"];
      }
      prepare[path] = copy;
    }
  }

  const schemas: Record<string, Schema> = {};
  for (const name of ["Login", "Session", "Error", "Pagination", "ShiftInput", "Shift"]) {
    schemas[name] = base.components.schemas[name];
  }

  const customerReturnTag = "02. F05 - Khách trả & Đổi hàng tại quầy";
  const vendorReturnTag = "03. F06 - Trả hàng Nhà cung cấp";

  Object.assign(schemas, {
    CustomerReturnItemInput: object(
      {
        orderItemId: { ...uuid, description: "ID dòng đơn hàng gốc (tùy chọn nếu isUnverifiedOrigin=true)" },
        variantId: { ...uuid, description: "ID SKU sản phẩm trả" },
        lotId: { ...uuid, description: "ID lô hàng (nếu quản lý theo lô)" },
        returnQty: { type: "integer", minimum: 1, example: 1, description: "Số lượng trả" },
        returnUnitPrice: { ...money, description: "Đơn giá trả (tùy chọn, mặc định lấy từ đơn gốc)" },
        itemCondition: {
          type: "string",
          enum: ["RESTOCKABLE", "DAMAGED_QUARANTINE"],
          example: "RESTOCKABLE",
          description: "RESTOCKABLE: nhập lại kệ bán; DAMAGED_QUARANTINE: cách ly chờ F08 hủy",
        },
        reason: text(255),
      },
      ["variantId", "returnQty", "itemCondition"]
    ),

    ExchangeItemInput: object(
      {
        variantId: { ...uuid, description: "ID SKU sản phẩm khách muốn đổi lấy" },
        quantity: { type: "integer", minimum: 1, example: 1, description: "Số lượng đổi" },
      },
      ["variantId", "quantity"]
    ),

    CustomerReturnInput: object(
      {
        originalOrderCode: { ...text(50), example: "ORD-179368", description: "Mã đơn hàng gốc POS" },
        originalOrderId: { ...uuid, description: "ID đơn hàng gốc (nếu có)" },
        isUnverifiedOrigin: { type: "boolean", default: false, description: "Trả không hóa đơn gốc (chỉ OWNER mới được thực hiện)" },
        returnReason: { ...text(255), example: "Khách đổi size" },
        refundMethod: {
          type: "string",
          enum: ["CASH", "BANK_TRANSFER", "CUSTOMER_CREDIT", "EXCHANGE_OFFSET"],
          example: "CASH",
          description: "Phương thức hoàn tiền hoặc cấn trừ đổi hàng",
        },
        items: {
          type: "array",
          minItems: 1,
          items: ref("CustomerReturnItemInput"),
        },
        exchangeItems: {
          type: "array",
          items: ref("ExchangeItemInput"),
          description: "Danh sách sản phẩm đổi mới ngay tại quầy",
        },
      },
      ["refundMethod", "items"]
    ),

    CustomerReturnItem: object({
      id: uuid,
      variantId: uuid,
      lotId: { ...uuid, nullable: true },
      returnQty: { type: "integer" },
      returnUnitPrice: money,
      itemCondition: { type: "string", enum: ["RESTOCKABLE", "DAMAGED_QUARANTINE"] },
      reason: { type: "string", nullable: true },
    }),

    CustomerReturn: object({
      id: uuid,
      businessId: uuid,
      returnCode: text(50),
      originalOrderId: { ...uuid, nullable: true },
      isUnverifiedOrigin: { type: "boolean" },
      status: { type: "string", enum: ["COMPLETED", "CANCELLED"] },
      refundMethod: { type: "string" },
      totalRefundAmount: money,
      exchangeOrderId: { ...uuid, nullable: true },
      createdAt: { type: "string", format: "date-time" },
      items: { type: "array", items: ref("CustomerReturnItem") },
    }),

    CustomerReturnsList: object({
      items: { type: "array", items: ref("CustomerReturn") },
      pagination: ref("Pagination"),
    }),

    OrderLookupResult: object({
      order: { type: "object", additionalProperties: true },
      items: {
        type: "array",
        items: object({
          orderItemId: uuid,
          variantId: uuid,
          lotId: { ...uuid, nullable: true },
          sku: { type: "string" },
          productName: { type: "string" },
          unitPrice: money,
          purchasedQty: { type: "integer" },
          alreadyReturnedQty: { type: "integer" },
          remainingReturnableQty: { type: "integer" },
        }),
      },
    }),

    VendorReturnItemInput: object(
      {
        variantId: { ...uuid, description: "ID SKU sản phẩm trả lại NCC" },
        lotId: { ...uuid, description: "ID lô hàng (nếu quản lý theo lô)" },
        returnQty: { type: "integer", minimum: 1, example: 2, description: "Số lượng trả NCC" },
        returnUnitPrice: { ...money, example: "50000.00", description: "Đơn giá trả NCC" },
        conditionSource: {
          type: "string",
          enum: ["SELLABLE", "DAMAGED_STOCK"],
          default: "SELLABLE",
          description: "Kho xuất trả: SELLABLE (bán được) hoặc DAMAGED_STOCK (hàng hỏng/cách ly)",
        },
        reason: text(255),
      },
      ["variantId", "returnQty", "returnUnitPrice"]
    ),

    VendorReturnInput: object(
      {
        supplierId: { ...uuid, description: "ID Nhà cung cấp" },
        receiptId: { ...uuid, description: "ID phiếu nhập kho gốc (tùy chọn)" },
        returnReason: { ...text(255), example: "Hàng lỗi nhà sản xuất" },
        paymentRefundMethod: {
          type: "string",
          enum: ["DEBT_DEDUCTION", "CASH", "BANK_TRANSFER"],
          default: "DEBT_DEDUCTION",
          description: "Giảm trừ công nợ hoặc hoàn tiền mặt/chuyển khoản",
        },
        items: {
          type: "array",
          minItems: 1,
          items: ref("VendorReturnItemInput"),
        },
      },
      ["supplierId", "items"]
    ),

    VendorReturnItem: object({
      id: uuid,
      variantId: uuid,
      lotId: { ...uuid, nullable: true },
      returnQty: { type: "integer" },
      returnUnitPrice: money,
      subtotal: money,
      conditionSource: { type: "string" },
      reason: { type: "string", nullable: true },
    }),

    VendorReturn: object({
      id: uuid,
      businessId: uuid,
      returnCode: text(50),
      supplierId: uuid,
      status: { type: "string", enum: ["COMPLETED", "CANCELLED"] },
      totalReturnValue: money,
      paymentRefundMethod: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      items: { type: "array", items: ref("VendorReturnItem") },
    }),

    VendorReturnsList: object({
      items: { type: "array", items: ref("VendorReturn") },
      pagination: ref("Pagination"),
    }),
  });

  return {
    openapi: "3.0.3",
    info: {
      title: "F05 & F06 - Đổi trả hàng",
      version: "1.0.0",
      description:
        "Swagger API cho F05 (Khách trả & Đổi hàng tại quầy) và F06 (Trả hàng Nhà cung cấp).\n\n" +
        "1. Đăng nhập qua POST /auth/v1/token để Swagger tự động gắn Bearer Token.\n" +
        "2. Kiểm tra thông tin cửa hàng qua GET /auth/me.\n" +
        "3. F05: Tra cứu đơn hàng theo mã (GET /customer-returns/lookup/{orderCode}) -> Tạo phiếu khách trả/đổi (POST /customer-returns).\n" +
        "4. F06: Lấy danh sách NCC (GET /vendor-returns/suppliers) -> Tạo phiếu trả NCC giảm công nợ (POST /vendor-returns - chỉ OWNER).",
    },
    servers: [{ url: "/api", description: "Backend API" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: base.components.securitySchemes,
      schemas,
    },
    tags: [
      { name: "00. Đăng nhập" },
      { name: "01. Chuẩn bị và đối chiếu" },
      { name: customerReturnTag },
      { name: vendorReturnTag },
    ],
    paths: {
      ...prepare,

      // F05 Customer Returns
      "/customer-returns/lookup/{orderCode}": {
        get: op(
          "f05LookupOrder",
          customerReturnTag,
          "Tra cứu hóa đơn gốc theo mã đơn (ORD-...)",
          ref("OrderLookupResult"),
          {
            parameters: [{ name: "orderCode", in: "path", required: true, schema: text(50) }],
            description: "Lấy chi tiết đơn hàng, số lượng đã mua, đã trả trước đó và số lượng còn được phép trả.",
          }
        ),
      },
      "/customer-returns": {
        get: op(
          "f05ListReturns",
          customerReturnTag,
          "Danh sách phiếu khách trả / đổi hàng",
          ref("CustomerReturnsList"),
          {
            parameters: [
              ...paging,
              query("status", { type: "string", enum: ["COMPLETED", "CANCELLED"] }),
            ],
          }
        ),
        post: op(
          "f05CreateReturn",
          customerReturnTag,
          "Tạo phiếu khách trả hàng / đổi hàng tại quầy",
          ref("CustomerReturn"),
          {
            input: "CustomerReturnInput",
            write: true,
            status: 201,
            description:
              "Hỗ trợ hoàn tiền mặt (yêu cầu ca OPEN), hoàn hàng bán được (RESTOCKABLE) hoặc hàng lỗi (DAMAGED_QUARANTINE), và đổi sản phẩm mới (exchangeItems). Chặn 409 nếu SKU bị khóa kiểm kê F07 hoặc trả vượt số lượng.",
          }
        ),
      },
      "/customer-returns/{id}": {
        get: op(
          "f05GetReturn",
          customerReturnTag,
          "Chi tiết phiếu khách trả theo ID",
          ref("CustomerReturn"),
          {
            parameters: [{ name: "id", in: "path", required: true, schema: uuid }],
          }
        ),
      },

      // F06 Vendor Returns
      "/vendor-returns/suppliers": {
        get: op(
          "f06GetSuppliers",
          vendorReturnTag,
          "Danh sách nhà cung cấp & số dư công nợ hiện tại",
          { type: "array", items: { type: "object", additionalProperties: true } },
          { description: "Lấy danh sách NCC thuộc cửa hàng để chọn đối tác xuất trả hàng." }
        ),
      },
      "/vendor-returns": {
        get: op(
          "f06ListReturns",
          vendorReturnTag,
          "Danh sách phiếu xuất trả hàng Nhà cung cấp",
          ref("VendorReturnsList"),
          {
            parameters: [
              ...paging,
              query("supplierId", uuid),
              query("status", { type: "string", enum: ["COMPLETED", "CANCELLED"] }),
            ],
          }
        ),
        post: op(
          "f06CreateReturn",
          vendorReturnTag,
          "Tạo phiếu xuất trả hàng cho Nhà cung cấp (Chỉ OWNER)",
          ref("VendorReturn"),
          {
            input: "VendorReturnInput",
            write: true,
            status: 201,
            description:
              "Chỉ OWNER mới được thực hiện (STAFF bị 403). Trừ tồn bán được (SELLABLE) hoặc tồn lỗi cách ly (DAMAGED_STOCK), tự động giảm trừ công nợ NCC. Chặn 409 nếu SKU bị khóa kiểm kê F07 hoặc thiếu tồn kho.",
          }
        ),
      },
      "/vendor-returns/{id}": {
        get: op(
          "f06GetReturn",
          vendorReturnTag,
          "Chi tiết phiếu trả NCC theo ID",
          ref("VendorReturn"),
          {
            parameters: [{ name: "id", in: "path", required: true, schema: uuid }],
          }
        ),
      },
    },
  };
}

