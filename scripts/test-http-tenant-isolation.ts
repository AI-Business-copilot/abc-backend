import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import http from "http";
import app from "../src/app";

function buildConnectionString(raw?: string) {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return raw;
  }
}

const adapter = new PrismaPg({
  connectionString: buildConnectionString(process.env.DATABASE_URL)!,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("================================================================================");
  console.log("  TEST MULTI-TENANT ISOLATION QUA HTTP ĐẦY ĐỦ (AUTH + BUSINESS SCOPE MIDDLEWARE)");
  console.log("================================================================================\n");

  const runId = Date.now().toString().slice(-6);

  // 1. Lấy token thật từ Supabase Auth cho User probe-zz2@example.com
  const email = "probe-zz2@example.com";
  const password = "TestPassword123!";
  console.log(`[AUTH] Đang xác thực với Supabase Auth (${email})...`);

  const loginRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  const tokenData = (await loginRes.json()) as any;
  if (!tokenData.access_token) {
    throw new Error(`Failed to login via Supabase Auth: ${JSON.stringify(tokenData)}`);
  }
  const token = tokenData.access_token;
  console.log(`[AUTH] Đã cấp Bearer Token hợp lệ từ Supabase Auth.`);

  // 2. Tìm hoặc tạo User trong DB qua ensureUserProfile
  const userA = await prisma.user.upsert({
    where: { authUserId: tokenData.user.id },
    create: {
      authUserId: tokenData.user.id,
      email: tokenData.user.email,
      fullName: "User A Owner",
    },
    update: {
      email: tokenData.user.email,
    },
  });

  // Tìm role OWNER
  const ownerRole = await prisma.role.findFirstOrThrow({ where: { code: "OWNER" } });
  const staffRole = await prisma.role.findFirstOrThrow({ where: { code: "STAFF" } });

  // 3. Tạo Tenant A và gán User A làm OWNER có membership ACTIVE
  const businessA = await prisma.business.create({
    data: {
      name: `Doanh Nghiệp A (User A) ${runId}`,
      phone: `0911${runId}`,
      industryType: "RETAIL",
    },
  });
  await prisma.businessMembership.deleteMany({ where: { userId: userA.id } });
  await prisma.businessMembership.create({
    data: {
      businessId: businessA.id,
      userId: userA.id,
      roleId: ownerRole.id,
      status: "ACTIVE",
    },
  });
  console.log(`[SETUP] Đã tạo Doanh Nghiệp A: ${businessA.name} (ID: ${businessA.id})`);
  console.log(`[SETUP] User A (${userA.email}) là OWNER hợp lệ của Doanh Nghiệp A.`);

  // 4. Tạo Tenant B (Doanh Nghiệp B) hoàn toàn riêng biệt
  const businessB = await prisma.business.create({
    data: {
      name: `Doanh Nghiệp B (Nạn Nhân) ${runId}`,
      phone: `0922${runId}`,
      industryType: "RETAIL",
    },
  });
  const otherAuthId = "cec54aa7-d9ae-4627-9629-b4ba8ccd7835"; // huongtuti511
  const userB = await prisma.user.findFirstOrThrow({ where: { authUserId: otherAuthId } });
  await prisma.businessMembership.deleteMany({ where: { userId: userB.id } });
  await prisma.businessMembership.create({
    data: {
      businessId: businessB.id,
      userId: userB.id,
      roleId: ownerRole.id,
      status: "ACTIVE",
    },
  });
  console.log(`[SETUP] Đã tạo Doanh Nghiệp B: ${businessB.name} (ID: ${businessB.id})`);

  // Seed dữ liệu thuộc Doanh Nghiệp B:
  // - Category, Template, Variant của B
  const catB = await prisma.category.create({
    data: { businessId: businessB.id, name: `Danh Mục B ${runId}` },
  });
  const tplB = await prisma.productTemplate.create({
    data: {
      businessId: businessB.id,
      categoryId: catB.id,
      name: `Sản Phẩm Của B ${runId}`,
      hasLotTracking: true,
    },
  });
  const varB = await prisma.productVariant.create({
    data: {
      businessId: businessB.id,
      templateId: tplB.id,
      sku: `SKU-B-${runId}`,
      costPrice: new Prisma.Decimal("50000"),
      basePrice: new Prisma.Decimal("90000"),
    },
  });
  const lotB = await prisma.productLot.create({
    data: {
      businessId: businessB.id,
      variantId: varB.id,
      lotNumber: `LOT-B-${runId}`,
      expirationDate: new Date("2026-12-31"),
      status: "QUARANTINED",
      quarantineQty: 10,
    },
  });
  await prisma.inventoryBalance.create({
    data: {
      businessId: businessB.id,
      variantId: varB.id,
      lotId: lotB.id,
      quantityOnHand: 20,
      damagedQuantity: 0,
    },
  });

  // - PO của B (F03)
  const suppB = await prisma.supplier.create({
    data: { businessId: businessB.id, name: `NCC B ${runId}`, phone: `0944${runId}` },
  });
  const poB = await prisma.purchaseOrder.create({
    data: {
      businessId: businessB.id,
      supplierId: suppB.id,
      poCode: `PO-B-${runId}`,
      status: "ORDERED",
      createdBy: userB.id,
    },
  });

  // - Order của B (F04)
  const shiftB = await prisma.cashShift.create({
    data: { businessId: businessB.id, userId: userB.id, status: "OPEN", openingCash: 1000000 },
  });
  const orderB = await prisma.order.create({
    data: {
      businessId: businessB.id,
      shiftId: shiftB.id,
      cashierId: userB.id,
      orderCode: `ORD-B-${runId}`,
      status: "DRAFT",
      totalGrossAmount: new Prisma.Decimal("90000"),
      totalNetAmount: new Prisma.Decimal("90000"),
    },
  });

  // - Audit của B (F07)
  const auditB = await prisma.stockAudit.create({
    data: {
      businessId: businessB.id,
      auditCode: `AUD-B-${runId}`,
      auditType: "CATEGORY_AUDIT",
      status: "IN_PROGRESS",
      createdBy: userB.id,
    },
  });
  const auditItemB = await prisma.stockAuditItem.create({
    data: {
      auditId: auditB.id,
      variantId: varB.id,
      lotId: lotB.id,
      snapshotQty: 20,
      countedQty: 20,
      diffQty: 0,
      itemStatus: "APPROVED",
    },
  });

  // - Scrap Order của B (F08)
  const scrapB = await prisma.scrapOrder.create({
    data: {
      businessId: businessB.id,
      scrapCode: `SCRAP-B-${runId}`,
      variantId: varB.id,
      lotId: lotB.id,
      scrapQty: 5,
      scrapSource: "SELLABLE_STOCK",
      scrapReason: "Hàng ẩm mốc thuộc B",
      unitCost: new Prisma.Decimal("50000"),
      totalLossValue: new Prisma.Decimal("250000"),
      status: "PENDING",
      createdBy: userB.id,
    },
  });
  const scrapImageB = await prisma.scrapOrderImage.create({
    data: {
      businessId: businessB.id,
      scrapOrderId: scrapB.id,
      storagePath: `${businessB.id}/scrap-orders/${scrapB.id}/img1.png`,
      mimeType: "image/png",
      sizeBytes: 100,
      uploadedBy: userB.id,
    },
  });

  console.log(`[SETUP] Đã chuẩn bị tài nguyên của Doanh Nghiệp B:`);
  console.log(`   - PO B: ${poB.poCode} (ID: ${poB.id})`);
  console.log(`   - Order B: ${orderB.orderCode} (ID: ${orderB.id})`);
  console.log(`   - Audit B: ${auditB.auditCode} (ID: ${auditB.id})`);
  console.log(`   - Scrap Order B: ${scrapB.scrapCode} (ID: ${scrapB.id})\n`);

  // 5. Khởi động HTTP Server nội bộ trên cổng ngẫu nhiên
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[HTTP] Server test đã sẵn sàng tại ${baseUrl}\n`);

  // Hàm gọi HTTP gửi kèm Bearer Token của User A
  async function callHttp(method: string, endpoint: string, body?: any) {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = await res.text();
    }
    return { status: res.status, data };
  }

  console.log("--------------------------------------------------------------------------------");
  console.log("TIẾN HÀNH KIỂM TRA USER A TRUY CẬP TRÁI PHÉP DỮ LIỆU CỦA DOANH NGHIỆP B QUA HTTP");
  console.log("--------------------------------------------------------------------------------\n");

  const testCases: Array<{
    stt: number;
    module: string;
    action: string;
    method: string;
    endpoint: string;
    body?: any;
    expectedStatus: number;
    actualStatus?: number;
    result?: string;
    responseMsg?: string;
  }> = [
    // 1. F03 Purchases: Đọc PO của B
    {
      stt: 1,
      module: "F03 Purchases",
      action: "Đọc chi tiết đơn mua (PO) của B",
      method: "GET",
      endpoint: `/api/purchases/orders/${poB.id}`,
      expectedStatus: 404,
    },
    // 2. F03 Purchases: Tạo PO cố tình truyền businessId của B
    {
      stt: 2,
      module: "F03 Purchases",
      action: "Tạo PO cố tình inject businessId của B",
      method: "POST",
      endpoint: `/api/purchases/orders`,
      body: {
        businessId: businessB.id,
        supplierId: suppB.id,
        poCode: `PO-HACK-${runId}`,
        items: [{ variantId: varB.id, orderedQty: 10, unitPrice: 50000 }],
      },
      expectedStatus: 403,
    },
    // 3. F04 Sales: Đọc Order của B
    {
      stt: 3,
      module: "F04 Sales",
      action: "Đọc chi tiết đơn bán hàng của B",
      method: "GET",
      endpoint: `/api/sales/orders/${orderB.id}`,
      expectedStatus: 404,
    },
    // 4. F04 Sales: Tạo đơn bán cố tình inject businessId của B
    {
      stt: 4,
      module: "F04 Sales",
      action: "Tạo đơn POS cố tình inject businessId của B",
      method: "POST",
      endpoint: `/api/sales/orders`,
      body: {
        businessId: businessB.id,
        orderCode: `ORD-HACK-${runId}`,
        items: [{ variantId: varB.id, quantity: 1 }],
      },
      expectedStatus: 403,
    },
    // 5. F07 Audit: Ghi số đếm (recordCount) vào đợt kiểm kê của B
    {
      stt: 5,
      module: "F07 Audit",
      action: "Ghi nhận số đếm (recordCount) vào đợt kiểm kê của B",
      method: "POST",
      endpoint: `/api/inventory/audits/${auditB.id}/items`,
      body: {
        variantId: varB.id,
        lotId: lotB.id,
        countedQty: 25,
      },
      expectedStatus: 404,
    },
    // 6. F07 Audit: Phê duyệt (approveAudit) đợt kiểm kê của B
    {
      stt: 6,
      module: "F07 Audit",
      action: "Phê duyệt đợt kiểm kê (approveAudit) của B",
      method: "PATCH",
      endpoint: `/api/inventory/audits/${auditB.id}/approve`,
      expectedStatus: 404,
    },
    // 7. F07 Audit: Áp dụng (applyAudit) đợt kiểm kê của B
    {
      stt: 7,
      module: "F07 Audit",
      action: "Áp dụng điều chỉnh kho (applyAudit) đợt của B",
      method: "PATCH",
      endpoint: `/api/inventory/audits/${auditB.id}/apply`,
      expectedStatus: 404,
    },
    // 8. F08 Scrap: Phê duyệt lệnh xuất hủy (approveScrapOrder) của B
    {
      stt: 8,
      module: "F08 Scrap",
      action: "Phê duyệt xuất hủy (approveScrapOrder) của B",
      method: "PATCH",
      endpoint: `/api/inventory/scrap-orders/${scrapB.id}/approve`,
      body: {
        reviewedImageIds: [scrapImageB.id],
      },
      expectedStatus: 404,
    },
    // 9. F08 Scrap: Từ chối lệnh xuất hủy (rejectScrapOrder) của B
    {
      stt: 9,
      module: "F08 Scrap",
      action: "Từ chối xuất hủy (rejectScrapOrder) của B",
      method: "PATCH",
      endpoint: `/api/inventory/scrap-orders/${scrapB.id}/reject`,
      body: {
        reasonCode: "PHOTO_UNCLEAR",
        note: "Từ chối kiểm thử đa tenant",
      },
      expectedStatus: 404,
    },
    // 10. Truy vấn danh sách đợt kiểm kê kèm param ?businessId=B
    {
      stt: 10,
      module: "F07 Audit",
      action: "Liệt kê danh sách audit kèm param ?businessId của B",
      method: "GET",
      endpoint: `/api/inventory/audits?businessId=${businessB.id}`,
      expectedStatus: 403,
    },
  ];

  for (const tc of testCases) {
    const res = await callHttp(tc.method, tc.endpoint, tc.body);
    tc.actualStatus = res.status;
    const msg = res.data?.message || res.data?.error || JSON.stringify(res.data);
    tc.responseMsg = typeof msg === "string" ? msg.slice(0, 70) : "";
    tc.result = tc.actualStatus === tc.expectedStatus ? "PASS (CHẶN THÀNH CÔNG)" : "FAIL (RÒ RỈ DỮ LIỆU)";
  }

  server.close();

  console.log("=== BẢNG TỔNG HỢP KẾT QUẢ KIỂM THỬ ĐỘ CÔ LẬP TENANT QUA HTTP ===");
  console.table(
    testCases.map((tc) => ({
      STT: tc.stt,
      Module: tc.module,
      "Hành động thử nghiệm": tc.action,
      Endpoint: `${tc.method} ${tc.endpoint.slice(0, 35)}`,
      "Mã mong đợi": tc.expectedStatus,
      "Mã thực tế": tc.actualStatus,
      "Kết quả": tc.result,
      "Phản hồi server": tc.responseMsg,
    })),
  );

  const allPassed = testCases.every((tc) => tc.result?.startsWith("PASS"));
  if (allPassed) {
    console.log("\n=> KẾT LUẬN: TOÀN BỘ 10/10 TEST CASE CÔ LẬP TENANT ĐỀU ĐẠT (PASS).");
    console.log("   - Không thể đọc/ghi dữ liệu của tenant khác (404 Not Found hoặc 403 Forbidden).");
    console.log("   - Middleware auth (requireSupabaseIdentity) & scope (requireBusinessScope) hoạt động chính xác 100%.");
  } else {
    console.log("\n=> CẢNH BÁO: PHÁT HIỆN RÒ RỈ DỮ LIỆU GIỮA CÁC TENANT!");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL ERROR running tenant isolation test:", err);
  process.exit(1);
});
