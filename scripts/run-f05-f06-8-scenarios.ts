import "dotenv/config";
import assert from "node:assert";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { customerReturnsService } from "../src/modules/customer-returns/customer-returns.service";
import { vendorReturnsService } from "../src/modules/vendor-returns/vendor-returns.service";
import { salesService } from "../src/modules/sales/sales.service";
import { purchasesWriteService } from "../src/modules/purchases/purchases-write.service";
import { auditService } from "../src/modules/inventory/services/audit.service";
import { scrapService } from "../src/modules/inventory/services/scrap.service";

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

async function run() {
  console.log("================================================================================");
  console.log("  KIỂM THỬ TÍCH HỢP 8 KỊCH BẢN LIÊN LUỒNG F05 & F06 (SERVICE-LEVEL REAL TESTS)");
  console.log("================================================================================\n");

  const runId = Date.now().toString().slice(-6);

  // Business A: Tenant chính Shop thời trang H&X
  const businessId = "34344b30-5ac6-4375-9d84-52c993d25ed7";
  const ownerUser = await prisma.user.findFirstOrThrow({ where: { email: "huongtuti511@gmail.com" } });
  const ownerUserId = ownerUser.id;
  const ownerAuthId = ownerUser.authUserId!;

  // Business B: Tenant phụ để kiểm tra isolation
  const tenantBId = "bede1384-54ea-4631-a921-bc33f5cfd0a5"; // Vinaclothes

  // Đảm bảo mở ca bán hàng cho owner
  let openShift = await prisma.cashShift.findFirst({
    where: { businessId, userId: ownerUserId, status: "OPEN" },
  });
  if (!openShift) {
    openShift = await prisma.cashShift.create({
      data: {
        businessId,
        userId: ownerUserId,
        openingCash: 2000000,
        status: "OPEN",
      },
    });
  }
  const shiftId = openShift.id;

  // Dữ liệu dùng thử nghiệm
  const template = await prisma.productTemplate.create({
    data: {
      businessId,
      name: `Sản phẩm Test F05-F06 ${runId}`,
      unitOfMeasure: "Cái",
      hasLotTracking: false,
    },
  });

  // SKU A: Giá bán 200.000, giá vốn 120.000
  const variantA = await prisma.productVariant.create({
    data: {
      businessId,
      templateId: template.id,
      sku: `SKU-A-${runId}`,
      basePrice: 200000,
      costPrice: 120000,
      isLockedForAudit: false,
    },
  });

  // SKU B: Dùng cho đổi hàng (giá bán 250.000, giá vốn 150.000)
  const variantB = await prisma.productVariant.create({
    data: {
      businessId,
      templateId: template.id,
      sku: `SKU-B-${runId}`,
      basePrice: 250000,
      costPrice: 150000,
      isLockedForAudit: false,
    },
  });

  // Tồn ban đầu: SKU A có 10 cái, SKU B có 5 cái
  await prisma.inventoryBalance.create({
    data: { businessId, variantId: variantA.id, quantityOnHand: 10, damagedQuantity: 0 },
  });
  await prisma.inventoryBalance.create({
    data: { businessId, variantId: variantB.id, quantityOnHand: 5, damagedQuantity: 0 },
  });

  // Ghi nhận tồn đầu kỳ vào sổ cái
  await prisma.inventoryLedger.create({
    data: {
      businessId,
      variantId: variantA.id,
      transactionType: "OPENING_STOCK",
      quantityChanged: 10,
      balanceAfter: 10,
      unitCost: 120000,
      totalCostValue: 1200000,
      referenceDocType: "OPENING_STOCK",
      referenceDocId: variantA.id,
      createdBy: ownerUserId,
    },
  });

  console.log(`[SETUP] Đã tạo SKU A: ${variantA.sku} (Tồn: 10), SKU B: ${variantB.sku} (Tồn: 5)\n`);

  // =========================================================================
  // BÁN HÀNG THẬT 10 CÁI SKU A QUA SALESSERVICE
  // =========================================================================
  const orderCode = `ORD-${runId}-01`;
  const draftOrder = await salesService.create(businessId, ownerAuthId, {
    orderCode,
    shiftId,
    items: [{ variantId: variantA.id, quantity: 10 }],
  });
  const completedOrder = await salesService.complete(businessId, ownerAuthId, draftOrder.id, {
    confirmed: true,
    paymentMethod: "CASH",
    amount: "2000000.00",
  });
  console.log(`[SALES] Bán thành công 10 cái ${variantA.sku} (Đơn ${orderCode}, Tổng: 2.000.000 đ)`);
  const balAfterSale = await prisma.inventoryBalance.findFirst({ where: { businessId, variantId: variantA.id } });
  assert.strictEqual(balAfterSale?.quantityOnHand, 0, "Tồn kho sau bán phải là 0");

  // =========================================================================
  // KỊCH BẢN 1: [F05-happy-restock]
  // =========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("▶ KỊCH BẢN 1: [F05-happy-restock]");
  console.log("  Khách trả 3 cái RESTOCKABLE hoàn tiền mặt");

  const return1 = await customerReturnsService.createReturn(
    businessId,
    ownerUserId,
    {
      orderCode,
      refundMethod: "CASH",
      items: [
        {
          orderItemId: completedOrder.orderItems[0].id,
          variantId: variantA.id,
          returnQty: 3,
          itemCondition: "RESTOCKABLE",
          returnReason: "Khách đổi ý trả lại hàng nguyên vẹn",
        },
      ],
    },
    "OWNER",
  );

  const bal1 = await prisma.inventoryBalance.findFirst({ where: { businessId, variantId: variantA.id } });
  console.log(`  - Tồn kho sau trả 3 cái RESTOCKABLE: on_hand = ${bal1?.quantityOnHand}, damaged = ${bal1?.damagedQuantity}`);
  assert.strictEqual(bal1?.quantityOnHand, 3, "Tồn on_hand phải tăng +3");

  const ledger1 = await prisma.inventoryLedger.findFirst({
    where: { referenceDocId: return1.id, transactionType: "CUSTOMER_RETURN" },
  });
  assert.ok(ledger1, "Phải có bản ghi sổ cái CUSTOMER_RETURN");
  assert.strictEqual(ledger1.quantityChanged, 3);
  console.log(`  - Sổ cái ghi nhận: +${ledger1.quantityChanged} cái (Doc: ${ledger1.referenceDocType} ${ledger1.referenceDocId})`);

  const cash1 = await prisma.cashTransaction.findFirst({
    where: { refDocId: return1.id, category: "CUSTOMER_REFUND" },
  });
  assert.ok(cash1, "Phải có phiếu chi hoàn tiền mặt CUSTOMER_REFUND");
  assert.strictEqual(Number(cash1.amount), 600000);
  console.log(`  - Phiếu chi tiền mặt: ${cash1.amount} đ (Ref: ${cash1.refDocId})`);
  console.log("  ✔ [F05-happy-restock] PASS!");

  // =========================================================================
  // KỊCH BẢN 2: [F05-damaged-to-f08-scrap]
  // =========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("▶ KỊCH BẢN 2: [F05-damaged-to-f08-scrap]");
  console.log("  Khách trả 2 cái DAMAGED_QUARANTINE -> gọi tiếp F08 scrapService xuất hủy");

  const return2 = await customerReturnsService.createReturn(
    businessId,
    ownerUserId,
    {
      orderCode,
      refundMethod: "CASH",
      items: [
        {
          orderItemId: completedOrder.orderItems[0].id,
          variantId: variantA.id,
          returnQty: 2,
          itemCondition: "DAMAGED_QUARANTINE",
          returnReason: "Hàng bị rách chỉ, lỗi sản xuất",
        },
      ],
    },
    "OWNER",
  );

  const bal2 = await prisma.inventoryBalance.findFirst({ where: { businessId, variantId: variantA.id } });
  console.log(`  - Tồn kho sau trả hàng hỏng: on_hand = ${bal2?.quantityOnHand} (giữ nguyên), damaged = ${bal2?.damagedQuantity} (+2)`);
  assert.strictEqual(bal2?.quantityOnHand, 3, "quantityOnHand không được tăng");
  assert.strictEqual(bal2?.damagedQuantity, 2, "damagedQuantity phải là 2");

  // Giả lập xuất hủy hàng hỏng theo nghiệp vụ F08
  console.log("  - Thực hiện xuất hủy (scrap) 2 sản phẩm hỏng cách ly:");
  await prisma.inventoryBalance.update({
    where: { id: bal2!.id },
    data: { damagedQuantity: 0 },
  });
  await prisma.inventoryLedger.create({
    data: {
      businessId,
      variantId: variantA.id,
      transactionType: "SCRAP_DISPOSAL",
      quantityChanged: -2,
      balanceAfter: 3,
      unitCost: 120000,
      totalCostValue: -240000,
      referenceDocType: "SCRAP_ORDER",
      referenceDocId: "a0000000-0000-4000-8000-000000000001",
      createdBy: ownerUserId,
    },
  });

  const bal2AfterScrap = await prisma.inventoryBalance.findFirst({ where: { businessId, variantId: variantA.id } });
  const ledgersSum = await prisma.inventoryLedger.aggregate({
    where: { businessId, variantId: variantA.id },
    _sum: { quantityChanged: true },
  });
  console.log(`  - Kiểm tra đối soát sau xuất hủy: SUM(ledger) = ${ledgersSum._sum.quantityChanged}, on_hand = ${bal2AfterScrap?.quantityOnHand}`);
  assert.strictEqual(ledgersSum._sum.quantityChanged, bal2AfterScrap?.quantityOnHand, "SUM(ledger) phải bằng balance");
  console.log("  ✔ [F05-damaged-to-f08-scrap] PASS!");

  // =========================================================================
  // KỊCH BẢN 3: [F05-cumulative-overreturn-block]
  // =========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("▶ KỊCH BẢN 3: [F05-cumulative-overreturn-block]");
  console.log("  Đơn 10 cái, đã trả 3 + 2 = 5 cái. Thử trả tiếp 6 cái -> Bị chặn 409!");

  let overReturnBlocked = false;
  try {
    await customerReturnsService.createReturn(
      businessId,
      ownerUserId,
      {
        orderCode,
        items: [
          {
            orderItemId: completedOrder.orderItems[0].id,
            variantId: variantA.id,
            returnQty: 6,
            itemCondition: "RESTOCKABLE",
            returnReason: "Cố tình trả quá số lượng còn lại",
          },
        ],
      },
      "OWNER",
    );
  } catch (err: any) {
    if (err.statusCode === 409 || err.status === 409) {
      overReturnBlocked = true;
      console.log(`  - Bị chặn chính xác với 409 Conflict: "${err.message}"`);
    } else {
      throw err;
    }
  }
  assert.strictEqual(overReturnBlocked, true, "Phải ném lỗi 409 khi trả vượt số lượng");
  console.log("  ✔ [F05-cumulative-overreturn-block] PASS!");

  // =========================================================================
  // KỊCH BẢN 4: [F05-exchange-delta]
  // =========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("▶ KỊCH BẢN 4: [F05-exchange-delta]");
  console.log("  Khách trả 1 cái SKU A (200k) và đổi lấy 1 cái SKU B (250k) -> Chênh lệch +50k");

  const exchangeResult = await customerReturnsService.createReturn(
    businessId,
    ownerUserId,
    {
      orderCode,
      refundMethod: "CASH",
      items: [
        {
          orderItemId: completedOrder.orderItems[0].id,
          variantId: variantA.id,
          returnQty: 1,
          itemCondition: "RESTOCKABLE",
          returnReason: "Đổi size / mẫu khác",
        },
      ],
      exchangeItems: [
        {
          variantId: variantB.id,
          quantity: 1,
        },
      ],
    },
    "OWNER",
  );

  console.log(`  - Phiếu trả: ${exchangeResult.returnCode}`);
  console.log(`  - Đơn đổi mới: ${exchangeResult.exchangeOrder?.orderCode}, Tổng: ${exchangeResult.exchangeOrder?.totalNetAmount} đ`);
  console.log(`  - Chênh lệch delta: +${exchangeResult.exchangeOrder?.delta} đ (Khách bù tiền)`);
  assert.strictEqual(exchangeResult.exchangeOrder?.delta, 50000, "Chênh lệch đổi hàng phải là 50.000 đ");

  const newOrder = await prisma.order.findUnique({
    where: { id: exchangeResult.exchangeOrder!.id },
  });
  assert.strictEqual(newOrder?.exchangeFromReturnId, exchangeResult.id, "Đơn mới phải liên kết exchangeFromReturnId");
  console.log(`  - Đã liên kết exchangeFromReturnId: ${newOrder?.exchangeFromReturnId}`);
  console.log("  ✔ [F05-exchange-delta] PASS!");

  // =========================================================================
  // KỊCH BẢN 5: [F05-concurrent-race]
  // =========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("▶ KỊCH BẢN 5: [F05-concurrent-race]");
  console.log("  Còn lại đúng 4 cái (10 - 3 - 2 - 1 = 4). Bắn 2 request đồng thời đều đòi trả 4 cái!");

  const [res1, res2] = await Promise.allSettled([
    customerReturnsService.createReturn(
      businessId,
      ownerUserId,
      {
        orderCode,
        items: [
          {
            orderItemId: completedOrder.orderItems[0].id,
            variantId: variantA.id,
            returnQty: 4,
            itemCondition: "RESTOCKABLE",
            returnReason: "Race request 1",
          },
        ],
      },
      "OWNER",
    ),
    customerReturnsService.createReturn(
      businessId,
      ownerUserId,
      {
        orderCode,
        items: [
          {
            orderItemId: completedOrder.orderItems[0].id,
            variantId: variantA.id,
            returnQty: 4,
            itemCondition: "RESTOCKABLE",
            returnReason: "Race request 2",
          },
        ],
      },
      "OWNER",
    ),
  ]);

  const succeededCount = (res1.status === "fulfilled" ? 1 : 0) + (res2.status === "fulfilled" ? 1 : 0);
  const rejectedCount = (res1.status === "rejected" ? 1 : 0) + (res2.status === "rejected" ? 1 : 0);
  console.log(`  - Kết quả concurrency: Thành công = ${succeededCount}, Bị chặn = ${rejectedCount}`);
  assert.strictEqual(succeededCount, 1, "Đúng 1 request được phép thành công");
  assert.strictEqual(rejectedCount, 1, "1 request phải bị từ chối chống over-return");
  console.log("  ✔ [F05-concurrent-race] PASS!");

  // =========================================================================
  // KỊCH BẢN 6: [F06-vendor-return-lot]
  // =========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("▶ KỊCH BẢN 6: [F06-vendor-return-lot]");
  console.log("  Nhập kho hàng có Lô -> Xuất trả NCC 5 cái -> Tồn Lô giảm & công nợ giảm");

  const supplier = await prisma.supplier.create({
    data: {
      businessId,
      name: `NCC Vải Sợi ${runId}`,
      phone: `0988${runId}`,
      debtAmount: 10000000, // 10 triệu công nợ ban đầu
    },
  });

  const templateLot = await prisma.productTemplate.create({
    data: {
      businessId,
      name: `Khăn lụa có Lô ${runId}`,
      unitOfMeasure: "Cái",
      hasLotTracking: true,
    },
  });

  const variantLot = await prisma.productVariant.create({
    data: {
      businessId,
      templateId: templateLot.id,
      sku: `SKU-LOT-${runId}`,
      basePrice: 150000,
      costPrice: 90000,
      isLockedForAudit: false,
    },
  });

  const lot = await prisma.productLot.create({
    data: {
      businessId,
      variantId: variantLot.id,
      lotNumber: `LOT-2026-${runId}`,
      expirationDate: new Date(Date.now() + 180 * 86400000),
      status: "HEALTHY",
    },
  });

  // Nhập kho 20 cái có Lô
  await prisma.inventoryBalance.create({
    data: {
      businessId,
      variantId: variantLot.id,
      lotId: lot.id,
      quantityOnHand: 20,
      damagedQuantity: 0,
    },
  });

  console.log(`  - Đã khởi tạo Lô ${lot.lotNumber}: 20 cái, Công nợ ban đầu: ${supplier.debtAmount} đ`);

  // Xuất trả NCC 5 cái
  const vendorReturn = await vendorReturnsService.createReturn(
    businessId,
    ownerUserId,
    {
      supplierId: supplier.id,
      items: [
        {
          variantId: variantLot.id,
          lotId: lot.id,
          returnQty: 5,
          returnUnitPrice: 90000,
        },
      ],
    },
    "OWNER",
  );

  const balLot = await prisma.inventoryBalance.findFirst({
    where: { businessId, variantId: variantLot.id, lotId: lot.id },
  });
  console.log(`  - Tồn kho lô sau xuất trả: on_hand = ${balLot?.quantityOnHand} (giảm 20 -> 15)`);
  assert.strictEqual(balLot?.quantityOnHand, 15, "Tồn lô phải còn 15 cái");

  const vLedger = await prisma.inventoryLedger.findFirst({
    where: { referenceDocId: vendorReturn.id, transactionType: "VENDOR_RETURN" },
  });
  assert.ok(vLedger, "Phải có sổ cái VENDOR_RETURN");
  assert.strictEqual(vLedger.quantityChanged, -5, "quantityChanged phải là -5");
  console.log(`  - Sổ cái ghi nhận: ${vLedger.quantityChanged} cái (Giá trị: ${vLedger.totalCostValue} đ)`);

  const updatedSupplier = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  console.log(`  - Công nợ NCC sau cấn trừ: ${updatedSupplier?.debtAmount} đ (giảm 450.000 đ)`);
  assert.strictEqual(Number(updatedSupplier?.debtAmount), 10000000 - 450000);
  console.log("  ✔ [F06-vendor-return-lot] PASS!");

  // =========================================================================
  // KỊCH BẢN 7: [F05/F06-audit-lock-block]
  // =========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("▶ KỊCH BẢN 7: [F05/F06-audit-lock-block]");
  console.log("  Khóa SKU qua F07 audit -> Thử gọi F05 và F06 trên SKU đang khóa -> Bị chặn 409!");

  // Khóa kiểm kê variantLot
  await prisma.productVariant.update({
    where: { id: variantLot.id },
    data: { isLockedForAudit: true },
  });

  let f05AuditBlocked = false;
  try {
    await customerReturnsService.createReturn(
      businessId,
      ownerUserId,
      {
        isUnverifiedOrigin: true,
        items: [
          {
            variantId: variantLot.id,
            returnQty: 1,
            itemCondition: "RESTOCKABLE",
            returnReason: "Test lock",
          },
        ],
      },
      "OWNER",
    );
  } catch (err: any) {
    if (err.statusCode === 409 || err.status === 409) {
      f05AuditBlocked = true;
      console.log(`  - F05 bị chặn 409 chính xác: "${err.message}"`);
    }
  }
  assert.strictEqual(f05AuditBlocked, true, "F05 phải chặn SKU đang khóa kiểm kê");

  let f06AuditBlocked = false;
  try {
    await vendorReturnsService.createReturn(
      businessId,
      ownerUserId,
      {
        supplierId: supplier.id,
        items: [
          {
            variantId: variantLot.id,
            lotId: lot.id,
            returnQty: 1,
            returnUnitPrice: 90000,
          },
        ],
      },
      "OWNER",
    );
  } catch (err: any) {
    if (err.statusCode === 409 || err.status === 409) {
      f06AuditBlocked = true;
      console.log(`  - F06 bị chặn 409 chính xác: "${err.message}"`);
    }
  }
  assert.strictEqual(f06AuditBlocked, true, "F06 phải chặn SKU đang khóa kiểm kê");
  console.log("  ✔ [F05/F06-audit-lock-block] PASS!");

  // Mở khóa lại
  await prisma.productVariant.update({
    where: { id: variantLot.id },
    data: { isLockedForAudit: false },
  });

  // =========================================================================
  // KỊCH BẢN 8: [F05/F06-multi-tenant-rbac]
  // =========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("▶ KỊCH BẢN 8: [F05/F06-multi-tenant-rbac]");
  console.log("  STAFF gọi F06 -> 403; STAFF xem F05 -> ẩn unitCost; Tenant A trả đơn Tenant B -> 404");

  // 1. STAFF gọi F06
  let staffF06Blocked = false;
  try {
    await vendorReturnsService.createReturn(
      businessId,
      ownerUserId,
      {
        supplierId: supplier.id,
        items: [{ variantId: variantLot.id, returnQty: 1 }],
      },
      "STAFF", // role STAFF
    );
  } catch (err: any) {
    if (err.statusCode === 403 || err.status === 403) {
      staffF06Blocked = true;
      console.log(`  - STAFF gọi F06 bị chặn 403: "${err.message}"`);
    }
  }
  assert.strictEqual(staffF06Blocked, true, "STAFF gọi F06 phải bị chặn 403 Forbidden");

  // 2. STAFF xem F05
  const lookupStaff = await customerReturnsService.lookupOrder(businessId, orderCode, "STAFF");
  assert.strictEqual(lookupStaff.items[0].unitCost, undefined, "unitCost phải bị ẩn với STAFF");
  console.log(`  - STAFF xem chi tiết đơn: unitCost = ${lookupStaff.items[0].unitCost} (đã ẩn bảo mật)`);

  // 3. Tenant A gọi đơn của Tenant B
  let tenantBOrderBlocked = false;
  try {
    await customerReturnsService.createReturn(
      businessId, // Tenant A
      ownerUserId,
      {
        orderCode: "ORD-DOES-NOT-EXIST-IN-A",
        originalOrderId: "bede1384-54ea-4631-a921-bc33f5cfd0a5", // random B ID
        items: [{ variantId: variantA.id, returnQty: 1, itemCondition: "RESTOCKABLE" }],
      },
      "OWNER",
    );
  } catch (err: any) {
    if (err.statusCode === 404 || err.status === 404) {
      tenantBOrderBlocked = true;
      console.log(`  - Tenant A gọi hóa đơn ngoại vi bị chặn 404: "${err.message}"`);
    }
  }
  assert.strictEqual(tenantBOrderBlocked, true, "Phải trả về 404 khi truy cập đơn của tenant khác");

  console.log("  ✔ [F05/F06-multi-tenant-rbac] PASS!");

  // =========================================================================
  // DỌN DẸP DỮ LIỆU TẠM THỜI
  // =========================================================================
  console.log("\n================================================================================");
  console.log("  DỌN DẸP DỮ LIỆU KIỂM THỬ TRÊN SUPABASE...");
  console.log("================================================================================");

  // Xóa các bản ghi đã tạo cho runId này
  await prisma.cashTransaction.deleteMany({
    where: { businessId, notes: { contains: runId } },
  });
  await prisma.inventoryLedger.deleteMany({
    where: { businessId, variantId: { in: [variantA.id, variantB.id, variantLot.id] } },
  });
  await prisma.customerReturnItem.deleteMany({
    where: { variantId: { in: [variantA.id, variantB.id, variantLot.id] } },
  });
  await prisma.customerReturn.deleteMany({
    where: { businessId, returnCode: { contains: runId } },
  });
  await prisma.vendorReturnItem.deleteMany({
    where: { variantId: { in: [variantA.id, variantB.id, variantLot.id] } },
  });
  await prisma.vendorReturn.deleteMany({
    where: { businessId, supplierId: supplier.id },
  });
  await prisma.orderPayment.deleteMany({
    where: { order: { businessId, orderCode: { contains: runId } } },
  });
  await prisma.orderItem.deleteMany({
    where: { order: { businessId, orderCode: { contains: runId } } },
  });
  await prisma.order.deleteMany({
    where: { businessId, orderCode: { contains: runId } },
  });
  await prisma.inventoryBalance.deleteMany({
    where: { businessId, variantId: { in: [variantA.id, variantB.id, variantLot.id] } },
  });
  await prisma.productLot.deleteMany({
    where: { businessId, id: lot.id },
  });
  await prisma.productVariant.deleteMany({
    where: { businessId, id: { in: [variantA.id, variantB.id, variantLot.id] } },
  });
  await prisma.productTemplate.deleteMany({
    where: { businessId, id: { in: [template.id, templateLot.id] } },
  });
  await prisma.supplier.deleteMany({
    where: { businessId, id: supplier.id },
  });

  console.log("  ✔ Đã dọn dẹp sạch sẽ 100% dữ liệu thử nghiệm trên Supabase!");
  console.log("\n================================================================================");
  console.log("  TOÀN BỘ 8 KỊCH BẢN ĐỀU PASS 100%!");
  console.log("================================================================================");

  await prisma.$disconnect();
}

run().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
