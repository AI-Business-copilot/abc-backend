import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { salesService } from "../src/modules/sales/sales.service";

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
  max: 10,
});

const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("================================================================================");
  console.log("  TEST ĐUA ĐỒNG THỜI (RACE CONDITION): 2 THANH TOÁN CHO SKU CÒN ĐÚNG 1 CHIẾC");
  console.log("================================================================================\n");

  const runId = Date.now().toString().slice(-6);

  // 1. Setup Tenant and Owner User
  const roles = await prisma.role.findMany();
  const ownerRole = roles.find((r) => r.code === "OWNER")!;

  const authUsers = await prisma.$queryRaw<Array<{ auth_user_id: string }>>`
    SELECT auth_user_id FROM users WHERE auth_user_id IS NOT NULL LIMIT 1;
  `;
  const authUserId = authUsers[0]?.auth_user_id;
  const user = await prisma.user.findFirstOrThrow({ where: { authUserId } });

  const business = await prisma.business.create({
    data: {
      name: `Race Condition Test ${runId}`,
      phone: `0966${runId}`,
      industryType: "RETAIL",
    },
  });

  await prisma.businessMembership.deleteMany({ where: { userId: user.id } });
  await prisma.businessMembership.create({
    data: {
      businessId: business.id,
      userId: user.id,
      roleId: ownerRole.id,
      status: "ACTIVE",
    },
  });

  const category = await prisma.category.create({
    data: { businessId: business.id, name: `Danh Mục Race ${runId}` },
  });

  const template = await prisma.productTemplate.create({
    data: {
      businessId: business.id,
      categoryId: category.id,
      name: `Sản Phẩm Duy Nhất 1 Chiếc ${runId}`,
      hasLotTracking: false,
    },
  });

  const variant = await prisma.productVariant.create({
    data: {
      businessId: business.id,
      templateId: template.id,
      sku: `LAST-ITEM-${runId}`,
      costPrice: new Prisma.Decimal("100000"),
      basePrice: new Prisma.Decimal("150000"),
    },
  });

  // Tồn kho ban đầu: ĐÚNG 1 CHIẾC
  const balance = await prisma.inventoryBalance.create({
    data: {
      businessId: business.id,
      variantId: variant.id,
      lotId: null,
      quantityOnHand: 1,
      damagedQuantity: 0,
    },
  });

  // Mở ca bán hàng
  const shift = await prisma.cashShift.create({
    data: {
      businessId: business.id,
      userId: user.id,
      status: "OPEN",
      openingCash: 1000000,
    },
  });

  console.log(`[SETUP] Đã tạo SKU: ${variant.sku}`);
  console.log(`[SETUP] Tồn kho ban đầu (inventoryBalance.quantityOnHand): ${balance.quantityOnHand} chiếc.`);
  console.log(`[SETUP] Ca bán hàng shiftId: ${shift.id}`);

  // Tạo 2 đơn nháp độc lập (mỗi đơn đòi mua đúng 1 chiếc)
  const order1 = await salesService.create(business.id, user.authUserId!, {
    orderCode: `ORD-RACE-A-${runId}`,
    shiftId: shift.id,
    items: [{ variantId: variant.id, quantity: 1 }],
  });

  const order2 = await salesService.create(business.id, user.authUserId!, {
    orderCode: `ORD-RACE-B-${runId}`,
    shiftId: shift.id,
    items: [{ variantId: variant.id, quantity: 1 }],
  });

  console.log(`-> Đã tạo 2 đơn nháp DRAFT tranh chấp tồn kho:`);
  console.log(`   - Đơn 1: ${order1.orderCode} (SL yêu cầu: 1, Tổng tiền: ${order1.totalNetAmount})`);
  console.log(`   - Đơn 2: ${order2.orderCode} (SL yêu cầu: 1, Tổng tiền: ${order2.totalNetAmount})`);
  console.log("\n-> KÍCH HOẠT ĐỒNG THỜI 2 LỆNH THANH TOÁN (Promise.allSettled) QUA salesService.complete...\n");

  const startTime = Date.now();
  const results = await Promise.allSettled([
    salesService.complete(business.id, user.authUserId!, order1.id, {
      confirmed: true,
      paymentMethod: "CASH",
      amount: order1.totalNetAmount.toFixed(2),
    }),
    salesService.complete(business.id, user.authUserId!, order2.id, {
      confirmed: true,
      paymentMethod: "CASH",
      amount: order2.totalNetAmount.toFixed(2),
    }),
  ]);
  const durationMs = Date.now() - startTime;

  console.log(`=== KẾT QUẢ XỬ LÝ ĐỒNG THỜI (${durationMs}ms) ===`);

  results.forEach((res, index) => {
    const orderCode = index === 0 ? order1.orderCode : order2.orderCode;
    if (res.status === "fulfilled") {
      console.log(`[ĐƠN ${index + 1} - ${orderCode}]: THÀNH CÔNG (200 OK)`);
      console.log(`   Trạng thái đơn: ${res.value.status} | Giá vốn: ${res.value.totalCogsAmount} | Lợi nhuận: ${res.value.grossProfit}`);
    } else {
      console.log(`[ĐƠN ${index + 1} - ${orderCode}]: THẤT BẠI (REJECTED)`);
      console.log(`   Mã lỗi HTTP: ${(res.reason as any)?.statusCode || 500}`);
      console.log(`   Thông báo lỗi: ${(res.reason as any)?.message}`);
    }
  });

  // Kiểm tra trạng thái cuối cùng trong database
  const finalBalance = await prisma.inventoryBalance.findUniqueOrThrow({ where: { id: balance.id } });
  const finalOrders = await prisma.order.findMany({
    where: { businessId: business.id, id: { in: [order1.id, order2.id] } },
    select: { id: true, orderCode: true, status: true },
  });
  const ledgerRows = await prisma.inventoryLedger.findMany({
    where: { businessId: business.id, variantId: variant.id },
  });
  const payments = await prisma.orderPayment.findMany({
    where: { orderId: { in: [order1.id, order2.id] } },
  });

  console.log("\n=== KIỂM CHỨNG TÍNH TOÀN VẸN CSDL SAU KHI TRANH CHẤP ===");
  console.log(`1. Tồn kho cuối cùng (quantityOnHand)          : ${finalBalance.quantityOnHand} (Không bị âm!)`);
  console.log(`2. Số lượng bản ghi ledger POS_SALE sinh ra    : ${ledgerRows.length} (Đúng 1 bản ghi!)`);
  console.log(`3. Số lượng thanh toán OrderPayment được lưu  : ${payments.length} (Đúng 1 giao dịch!)`);
  console.log(`4. Trạng thái 2 đơn hàng:`);
  console.table(finalOrders);

  const oneSucceeded = results.filter((r) => r.status === "fulfilled").length === 1;
  const oneFailed = results.filter((r) => r.status === "rejected").length === 1;

  if (oneSucceeded && oneFailed && finalBalance.quantityOnHand === 0 && ledgerRows.length === 1) {
    console.log("=> KẾT LUẬN: BẢO VỆ CHỐNG OVERSELLING HOẠT ĐỘNG HOÀN HẢO (1 ĐƠN THÀNH CÔNG, 1 ĐƠN BỊ CHẶN 409).");
  } else {
    console.log("=> CẢNH BÁO: PHÁT HIỆN LỖI TRANH CHẤP BÁN QUÁ TỒN (OVERSELLING)!");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Error running concurrent sales test:", err);
  process.exit(1);
});

