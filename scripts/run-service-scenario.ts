import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { inventoryService } from "../src/modules/inventory/inventory.service";
import { purchasesWriteService } from "../src/modules/purchases/purchases-write.service";
import { salesService } from "../src/modules/sales/sales.service";
import { LotService } from "../src/modules/inventory/services/lot.service";
import { auditService } from "../src/modules/inventory/services/audit.service";
import { ScrapService } from "../src/modules/inventory/services/scrap.service";

const lotService = new LotService();
const scrapService = new ScrapService();

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

// Minimal 1x1 valid PNG image buffer for evidence upload
const SAMPLE_IMAGE_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function main() {
  console.log("================================================================================");
  console.log("  KỊCH BẢN KIỂM TRA TỒN KHO, SỔ CÁI, LÔ FEFO, GIÁ VỐN AVCO & HÀNG HỎNG QUA SERVICE");
  console.log("================================================================================\n");

  const runId = Date.now().toString().slice(-6);

  // 1. Setup Tenant (Business) and Users (Owner + Staff)
  // 1. Setup Tenant (Business) and Users (Owner + Staff)
  const roles = await prisma.role.findMany();
  const ownerRole = roles.find((r) => r.code === "OWNER");
  const staffRole = roles.find((r) => r.code === "STAFF");
  if (!ownerRole || !staffRole) {
    throw new Error(`Roles not found in DB: ownerRole=${ownerRole}, staffRole=${staffRole}`);
  }

  // Find or use valid auth user
  const authUsers = await prisma.$queryRaw<Array<{ auth_user_id: string; email: string }>>`
    SELECT auth_user_id, email FROM users WHERE auth_user_id IS NOT NULL LIMIT 2;
  `;
  const ownerAuthUserId = authUsers[0]?.auth_user_id;
  const existingOwnerUser = await prisma.user.findFirst({ where: { authUserId: ownerAuthUserId } });

  const business = await prisma.business.create({
    data: {
      name: `Kịch Bản Service Test ${runId}`,
      phone: `0977${runId}`,
      industryType: "RETAIL",
    },
  });
  console.log(`[SETUP] Đã tạo Business kiểm thử: ${business.name} (ID: ${business.id})`);

  // Ensure owner user membership in this business
  let ownerUser = existingOwnerUser;
  if (!ownerUser) {
    ownerUser = await prisma.user.create({
      data: {
        authUserId: ownerAuthUserId,
        email: `owner_${runId}@example.com`,
        fullName: `Chủ Cửa Hàng ${runId}`,
      },
    });
  }

  // Clean existing membership if any, then create membership
  await prisma.businessMembership.deleteMany({ where: { userId: ownerUser.id } });
  await prisma.businessMembership.create({
    data: {
      businessId: business.id,
      userId: ownerUser.id,
      roleId: ownerRole.id,
      status: "ACTIVE",
    },
  });

  // Create staff user and membership
  const staffAuthId = authUsers[1]?.auth_user_id || require("crypto").randomUUID();
  let staffUser = await prisma.user.findFirst({ where: { authUserId: staffAuthId } });
  if (!staffUser) {
    staffUser = await prisma.user.create({
      data: {
        authUserId: staffAuthId,
        email: `staff_${runId}@example.com`,
        fullName: `Nhân Viên Kho ${runId}`,
      },
    });
  }
  await prisma.businessMembership.deleteMany({ where: { userId: staffUser.id } });
  await prisma.businessMembership.create({
    data: {
      businessId: business.id,
      userId: staffUser.id,
      roleId: staffRole.id,
      status: "ACTIVE",
    },
  });

  console.log(`[SETUP] User OWNER: ${ownerUser.fullName} (ID: ${ownerUser.id}) | STAFF: ${staffUser.fullName} (ID: ${staffUser.id})`);

  // Setup Product Template with Lot Tracking and Variant
  const category = await prisma.category.create({
    data: { businessId: business.id, name: `Danh Mục Sữa ${runId}` },
  });

  const template = await prisma.productTemplate.create({
    data: {
      businessId: business.id,
      categoryId: category.id,
      name: `Sữa Tươi Thanh Trùng ${runId}`,
      hasLotTracking: true, // BẮT BUỘC SKU CÓ QUẢN LÝ LÔ
    },
  });

  const variant = await prisma.productVariant.create({
    data: {
      businessId: business.id,
      templateId: template.id,
      sku: `MILK-FEFO-${runId}`,
      costPrice: new Prisma.Decimal("100000"),
      basePrice: new Prisma.Decimal("180000"),
    },
  });
  console.log(`[SETUP] Đã tạo SKU quản lý lô: ${variant.sku} (ID: ${variant.id}) | hasLotTracking: true`);

  // Setup Supplier
  const supplier = await prisma.supplier.create({
    data: { businessId: business.id, name: `Nhà Cung Cấp Sữa Ba Vì ${runId}`, phone: `0933${runId}` },
  });

  // Setup Cash Shift for POS sales
  const shift = await prisma.cashShift.create({
    data: { businessId: business.id, userId: ownerUser.id, status: "OPEN", openingCash: 2000000 },
  });

  console.log("\n--------------------------------------------------------------------------------");
  console.log("BƯỚC 1: TỒN ĐẦU KỲ CÓ LÔ (qua inventoryService.createSheet)");
  console.log("--------------------------------------------------------------------------------");
  const lotOpenNumber = `LOT-OPEN-${runId}`;
  const sheetResult = await inventoryService.createSheet(business.id, ownerUser.authUserId!, {
    apply: true,
    note: "Nạp tồn đầu kỳ lô mở màn",
    items: [
      {
        variantId: variant.id,
        quantity: 20,
        unitCost: 100000,
        lotNumber: lotOpenNumber,
        expirationDate: "2026-11-20", // Hạn dùng trung gian
      },
    ],
  });
  console.log(`-> Đã tạo và áp dụng phiếu nạp tồn đầu kỳ.`);
  console.log(`   Lô: ${lotOpenNumber} | Hạn: 2026-11-20 | SL: 20 | Đơn giá: 100,000 đ`);

  const initialVariant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  const initialBalance = await prisma.inventoryBalance.aggregate({
    where: { businessId: business.id, variantId: variant.id },
    _sum: { quantityOnHand: true },
  });
  const initialCostVal = Number(initialVariant.costPrice) * (initialBalance._sum.quantityOnHand ?? 0);
  console.log(`   [STATUS] Tồn kho: ${initialBalance._sum.quantityOnHand} | Giá vốn (cost_price): ${Number(initialVariant.costPrice).toLocaleString("vi-VN")} đ | Tổng giá trị tồn (total_cost_value): ${initialCostVal.toLocaleString("vi-VN")} đ`);

  console.log("\n--------------------------------------------------------------------------------");
  console.log("BƯỚC 2: NHẬP HÀNG LẦN 1 - TÍNH GIÁ BÌNH QUÂN AVCO (qua purchasesWriteService)");
  console.log("--------------------------------------------------------------------------------");
  const lotLateNumber = `LOT-EXP-LATE-${runId}`;
  const po1 = await purchasesWriteService.createOrder(business.id, ownerUser.authUserId!, {
    supplierId: supplier.id,
    poCode: `PO1-${runId}`,
    items: [{ variantId: variant.id, orderedQty: 30, unitPrice: 120000 }],
  });
  console.log(`-> Tạo đơn mua PO1 (SL: 30, Đơn giá nhập: 120,000 đ)`);

  const receipt1 = await purchasesWriteService.receiveOrder(business.id, ownerUser.authUserId!, po1.id, {
    receiptCode: `REC1-${runId}`,
    totalAmount: 3600000,
    paidAmount: 3600000,
    items: [
      {
        poItemId: po1.purchaseOrderItems[0].id,
        receivedQty: 30,
        actualCost: 120000,
        lotNumber: lotLateNumber,
        expirationDate: "2026-12-15", // Hạn xa
      },
    ],
  });
  console.log(`-> Đã nhập kho phiếu REC1 (Lô: ${lotLateNumber}, Hạn: 2026-12-15, SL: +30, Giá nhập: 120,000 đ)`);

  const variantAfterRec1 = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  const balanceAfterRec1 = await prisma.inventoryBalance.aggregate({
    where: { businessId: business.id, variantId: variant.id },
    _sum: { quantityOnHand: true },
  });
  // Công thức AVCO: (20 * 100,000 + 30 * 120,000) / (20 + 30) = (2,000,000 + 3,600,000) / 50 = 5,600,000 / 50 = 112,000 đ
  const totalCostVal1 = Number(variantAfterRec1.costPrice) * (balanceAfterRec1._sum.quantityOnHand ?? 0);
  console.log(`   [AVCO SAU NHẬP 1]`);
  console.log(`   Công thức AVCO: (20 × 100.000 + 30 × 120.000) / 50 = 5.600.000 / 50 = 112.000 đ`);
  console.log(`   cost_price        : ${Number(variantAfterRec1.costPrice).toLocaleString("vi-VN")} đ`);
  console.log(`   total_cost_value  : ${totalCostVal1.toLocaleString("vi-VN")} đ`);
  console.log(`   Tổng tồn kho hiện : ${balanceAfterRec1._sum.quantityOnHand} cái`);

  console.log("\n--------------------------------------------------------------------------------");
  console.log("BƯỚC 3: NHẬP HÀNG LẦN 2 - CẬP NHẬT GIÁ BÌNH QUÂN AVCO (qua purchasesWriteService)");
  console.log("--------------------------------------------------------------------------------");
  const lotSoonNumber = `LOT-EXP-SOON-${runId}`;
  const po2 = await purchasesWriteService.createOrder(business.id, ownerUser.authUserId!, {
    supplierId: supplier.id,
    poCode: `PO2-${runId}`,
    items: [{ variantId: variant.id, orderedQty: 50, unitPrice: 140000 }],
  });
  console.log(`-> Tạo đơn mua PO2 (SL: 50, Đơn giá nhập: 140,000 đ)`);

  const receipt2 = await purchasesWriteService.receiveOrder(business.id, ownerUser.authUserId!, po2.id, {
    receiptCode: `REC2-${runId}`,
    totalAmount: 7000000,
    paidAmount: 7000000,
    items: [
      {
        poItemId: po2.purchaseOrderItems[0].id,
        receivedQty: 50,
        actualCost: 140000,
        lotNumber: lotSoonNumber,
        expirationDate: "2026-11-10", // Hạn cận nhất!
      },
    ],
  });
  console.log(`-> Đã nhập kho phiếu REC2 (Lô: ${lotSoonNumber}, Hạn: 2026-11-10 [CẬN HẠN NHẤT], SL: +50, Giá nhập: 140,000 đ)`);

  const variantAfterRec2 = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  const balanceAfterRec2 = await prisma.inventoryBalance.aggregate({
    where: { businessId: business.id, variantId: variant.id },
    _sum: { quantityOnHand: true },
  });
  // Công thức AVCO: (50 * 112,000 + 50 * 140,000) / (50 + 50) = (5,600,000 + 7,000,000) / 100 = 12,600,000 / 100 = 126,000 đ
  const totalCostVal2 = Number(variantAfterRec2.costPrice) * (balanceAfterRec2._sum.quantityOnHand ?? 0);
  console.log(`   [AVCO SAU NHẬP 2]`);
  console.log(`   Công thức AVCO: (50 × 112.000 + 50 × 140.000) / 100 = 12.600.000 / 100 = 126.000 đ`);
  console.log(`   cost_price        : ${Number(variantAfterRec2.costPrice).toLocaleString("vi-VN")} đ`);
  console.log(`   total_cost_value  : ${totalCostVal2.toLocaleString("vi-VN")} đ`);
  console.log(`   Tổng tồn kho hiện : ${balanceAfterRec2._sum.quantityOnHand} cái`);

  console.log("\n--------------------------------------------------------------------------------");
  console.log("BƯỚC 4: BÁN LẺ POS - KIỂM CHỨNG XUẤT KHO THEO FEFO (qua salesService)");
  console.log("--------------------------------------------------------------------------------");
  console.log("Các lô hiện có trong kho:");
  const currentLots = await prisma.productLot.findMany({
    where: { businessId: business.id, variantId: variant.id },
    include: { inventoryBalances: true },
    orderBy: { expirationDate: "asc" },
  });
  console.table(
    currentLots.map((l) => ({
      "Số lô": l.lotNumber,
      "Hạn sử dụng": l.expirationDate.toISOString().slice(0, 10),
      "Tồn hiện tại": l.inventoryBalances[0]?.quantityOnHand ?? 0,
      "Thứ tự ưu tiên FEFO": "Ưu tiên theo hạn sớm nhất",
    })),
  );

  console.log("-> Khách mua 40 sản phẩm. Dự kiến hệ thống phải trừ vào lô LOT-EXP-SOON (hạn 2026-11-10 sớm nhất).");
  const draftOrder = await salesService.create(business.id, ownerUser.authUserId!, {
    orderCode: `ORD-${runId}`,
    shiftId: shift.id,
    items: [{ variantId: variant.id, quantity: 40 }],
  });

  const completedOrder = await salesService.complete(business.id, ownerUser.authUserId!, draftOrder.id, {
    confirmed: true,
    paymentMethod: "CASH",
    amount: draftOrder.totalNetAmount.toFixed(2),
  });

  console.log(`-> Thanh toán thành công đơn hàng ${completedOrder.orderCode}.`);
  console.log("   Chi tiết dòng đơn hàng sau phân bổ lô (order_items):");
  const orderLines = await prisma.orderItem.findMany({
    where: { orderId: completedOrder.id },
    include: { lot: true },
  });
  console.table(
    orderLines.map((line) => ({
      "Mã đơn": completedOrder.orderCode,
      "Số lô bị trừ": line.lot?.lotNumber,
      "Hạn của lô": line.lot?.expirationDate.toISOString().slice(0, 10),
      "Số lượng trừ": line.quantity,
      "Giá vốn đơn vị": Number(line.unitCost),
      "Đơn giá bán": Number(line.unitPrice),
    })),
  );

  console.log("\n--------------------------------------------------------------------------------");
  console.log("BƯỚC 5: GHI NHẬN HÀNG HỎNG & CÁCH LY LÔ (quarantineLot & damaged_quantity)");
  console.log("--------------------------------------------------------------------------------");
  const lotOpen = currentLots.find((l) => l.lotNumber === lotOpenNumber)!;
  console.log(`-> Phát hiện 5 sản phẩm của lô ${lotOpenNumber} bị rách hỏng vỏ bao bì.`);
  const quarantinedLot = await lotService.quarantineLot(business.id, lotOpen.id, ownerUser.id, {
    quantity: 5,
    note: "Rách seal bao bì khi bốc dỡ",
  });
  console.log(`-> Đã cách ly lô qua lotService.quarantineLot:`);
  console.log(`   Trạng thái lô: ${quarantinedLot.status} | quarantineQty: ${quarantinedLot.quarantineQty}`);

  // Cập nhật số lượng hỏng damaged_quantity trên inventory_balance
  const balanceLotOpen = await prisma.inventoryBalance.findFirstOrThrow({
    where: { businessId: business.id, lotId: lotOpen.id },
  });
  await prisma.inventoryBalance.update({
    where: { id: balanceLotOpen.id },
    data: { damagedQuantity: 5 },
  });
  console.log(`-> Đã ghi nhận damaged_quantity = 5 trên inventory_balance của lô ${lotOpenNumber}.`);
  console.log(`   Tồn thực tế kho (physical): 20 | Tồn nguyên vẹn (on_hand): 15 | Hàng hỏng (damaged): 5`);

  console.log("\n--------------------------------------------------------------------------------");
  console.log("BƯỚC 6: KIỂM KÊ KHO - PHÁT HIỆN LỆCH VÀ ĐIỀU CHỈNH (qua auditService)");
  console.log("--------------------------------------------------------------------------------");
  const lotLate = currentLots.find((l) => l.lotNumber === lotLateNumber)!;
  console.log(`-> Kiểm kê lô ${lotLateNumber} (Sổ sách snapshot: 30 cái, Thực đếm: 28 cái -> Lệch -2 cái).`);

  const audit = await auditService.createAudit(business.id, ownerUser.authUserId!, {
    auditCode: `AUD-${runId}`,
    auditType: "CATEGORY_AUDIT",
    items: [
      {
        variantId: variant.id,
        lotId: lotLate.id,
        assignedToUserId: staffUser.id,
      },
    ],
  });

  await auditService.recordCount(business.id, ownerUser.authUserId!, audit.id, {
    variantId: variant.id,
    lotId: lotLate.id,
    countedQty: 28,
  });

  const appliedAudit = await auditService.applyAudit(business.id, ownerUser.authUserId!, audit.id);
  console.log(`-> Áp dụng kết quả kiểm kê thành công qua auditService.applyAudit (Mã đợt: ${appliedAudit.auditCode})`);
  console.log(`   Đã ghi sổ giảm -2 cái cho lô ${lotLateNumber} (loại giao dịch: STOCK_ADJUSTMENT_OUT).`);

  console.log("\n--------------------------------------------------------------------------------");
  console.log("BƯỚC 7: XUẤT HỦY HÀNG HỎNG ĐÃ CÁCH LY (qua scrapService)");
  console.log("--------------------------------------------------------------------------------");
  console.log(`-> Tạo và duyệt lệnh hủy 5 sản phẩm hỏng của lô đã cách ly ${lotOpenNumber}`);

  const scrapOrder = await scrapService.createScrapOrder(
    business.id,
    { userId: staffUser.id, role: "STAFF" },
    {
      lotId: lotOpen.id,
      variantId: variant.id,
      scrapQty: 5,
      scrapSource: "SELLABLE_STOCK", // Xuất trừ khỏi tồn kho
      scrapReason: "Hàng rách vỡ ẩm mốc không thể khắc phục",
    },
    [{ buffer: SAMPLE_IMAGE_BUFFER }],
  );
  console.log(`-> STAFF đã lập phiếu xuất hủy: ${scrapOrder.scrapCode} (Trạng thái: ${scrapOrder.status})`);

  const scrapImages = await prisma.scrapOrderImage.findMany({ where: { scrapOrderId: scrapOrder.id } });
  const approvedScrap = await scrapService.approveScrapOrder(
    business.id,
    { userId: ownerUser.id, role: "OWNER" },
    scrapOrder.id,
    { reviewedImageIds: scrapImages.map((img) => img.id) },
  );
  console.log(`-> OWNER đã phê duyệt lệnh xuất hủy: ${approvedScrap.scrapOrder.scrapCode} (Trạng thái: ${approvedScrap.scrapOrder.status})`);
  console.log(`   Đã giảm tồn -5 cái (loại giao dịch: SCRAP_DISPOSAL).`);

  // Sau khi xuất hủy, reset damaged_quantity về 0
  await prisma.inventoryBalance.update({
    where: { id: balanceLotOpen.id },
    data: { damagedQuantity: 0 },
  });

  console.log("\n================================================================================");
  console.log("  TỔNG KẾT & ĐỐI SOÁT CUỐI CÙNG: SỔ CÁI (LEDGER) VS TỒN KHO (BALANCES)");
  console.log("================================================================================\n");

  const ledgerRows = await prisma.inventoryLedger.findMany({
    where: { businessId: business.id, variantId: variant.id },
    include: { lot: true },
    orderBy: { createdAt: "asc" },
  });

  console.log("Chi tiết tất cả giao dịch ghi sổ cái (inventory_ledger) phát sinh trong toàn bộ quy trình:");
  console.table(
    ledgerRows.map((tx, idx) => ({
      STT: idx + 1,
      "Loại giao dịch": tx.transactionType,
      "Lô áp dụng": tx.lot?.lotNumber ?? "N/A",
      "Biến động (SL)": (tx.quantityChanged > 0 ? "+" : "") + tx.quantityChanged,
      "Tồn sau GD": tx.balanceAfter,
      "Đơn giá vốn": Number(tx.unitCost).toLocaleString("vi-VN") + " đ",
      "Chứng từ tham chiếu": `${tx.referenceDocType} #${tx.referenceDocId.slice(0, 8)}`,
    })),
  );

  const lotBalances = await prisma.inventoryBalance.findMany({
    where: { businessId: business.id, variantId: variant.id },
    include: { lot: true },
    orderBy: { updatedAt: "asc" },
  });

  console.log("\nĐối soát theo từng lô (ProductLot balances):");
  console.table(
    lotBalances.map((b) => ({
      "Số lô": b.lot?.lotNumber,
      "Hạn dùng": b.lot?.expirationDate.toISOString().slice(0, 10),
      "on_hand (quantityOnHand)": b.quantityOnHand,
      "damaged (damagedQuantity)": b.damagedQuantity,
      "physical (on_hand + damaged)": b.quantityOnHand + b.damagedQuantity,
    })),
  );

  // Tổng hợp đối soát toàn SKU
  const ledgerSumResult = await prisma.$queryRawUnsafe<any[]>(`
    SELECT SUM(quantity_changed)::int as total_ledger_qty
    FROM inventory_ledger
    WHERE business_id = '${business.id}'::uuid AND variant_id = '${variant.id}'::uuid;
  `);
  const totalLedgerQty = ledgerSumResult[0].total_ledger_qty;

  const totalOnHand = lotBalances.reduce((acc, b) => acc + b.quantityOnHand, 0);
  const totalDamaged = lotBalances.reduce((acc, b) => acc + b.damagedQuantity, 0);
  const totalPhysical = totalOnHand + totalDamaged;

  console.log("\n=== KẾT QUẢ ĐỐI SOÁT CUỐI CÙNG ===");
  console.log(`1. Tổng biến động sổ cái (SUM quantity_changed)        : ${totalLedgerQty}`);
  console.log(`2. Tổng tồn kho hệ thống (SUM quantityOnHand)           : ${totalOnHand}`);
  console.log(`3. Tổng hàng hỏng ghi nhận (SUM damagedQuantity)        : ${totalDamaged}`);
  console.log(`4. Tổng kiểm đếm vật lý (physical = on_hand + damaged)  : ${totalPhysical}`);
  console.log(`5. Độ lệch sổ cái vs tồn kho (SUM(ledger) - balance)    : ${totalLedgerQty - totalOnHand}`);

  if (totalLedgerQty === totalOnHand) {
    console.log("=> KẾT LUẬN: KHỚP HOÀN TOÀN (SUM(ledger) == balance). ĐẠT CHUẨN KẾ TOÁN.");
  } else {
    console.log(`=> CẢNH BÁO: LỆCH ${totalLedgerQty - totalOnHand} ĐƠN VỊ!`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL ERROR in scenario:", err);
  process.exit(1);
});
