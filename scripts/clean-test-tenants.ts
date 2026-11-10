import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

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

const PRESERVED_BUSINESS_IDS = new Set([
  "bede1384-54ea-4631-a921-bc33f5cfd0a5", // Vinaclothes
  "34344b30-5ac6-4375-9d84-52c993d25ed7", // Shop thời trang H&X
  "ef312b72-a582-40b0-8474-4be0fd66d007", // Alone
  "6ea54c45-ac0b-4d7e-ba92-7627847fdd04", // Điện Máy Xan
  "2f3788b8-e48e-4dbd-8e55-98c82c618be6", // Mỹ phẩm Vinason
]);

async function main() {
  console.log("================================================================================");
  console.log("  LIỆT KÊ VÀ DỌN DẸP TOÀN BỘ CÁC TENANT TEST TRÊN SUPABASE");
  console.log("================================================================================\n");

  const allBusinesses = await prisma.business.findMany({
    select: { id: true, name: true, phone: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const testBusinesses = allBusinesses.filter((b) => !PRESERVED_BUSINESS_IDS.has(b.id));

  console.log(`Tìm thấy tổng cộng ${testBusinesses.length} tenant kiểm thử cần xóa trên Supabase:\n`);
  console.table(
    testBusinesses.map((b, idx) => ({
      STT: idx + 1,
      ID: b.id,
      "Tên Doanh Nghiệp Test": b.name,
      SĐT: b.phone,
      "Thời gian tạo": b.createdAt.toISOString(),
    })),
  );

  if (testBusinesses.length === 0) {
    console.log("Không có tenant test nào cần xóa.");
    process.exit(0);
  }

  const testIds = testBusinesses.map((b) => b.id);
  console.log("\n-> Đang thực hiện xóa tầng dữ liệu liên kết theo thứ tự phụ thuộc...");

  // Cascade delete dependent child records
  await prisma.$transaction(
    async (tx) => {
      await tx.scrapOrderImage.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.scrapOrder.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.stockAuditItem.deleteMany({ where: { audit: { businessId: { in: testIds } } } });
      await tx.stockAudit.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.customerReturnItem.deleteMany({ where: { return: { businessId: { in: testIds } } } });
      await tx.customerReturn.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.orderPayment.deleteMany({ where: { order: { businessId: { in: testIds } } } });
      await tx.orderItem.deleteMany({ where: { order: { businessId: { in: testIds } } } });
      await tx.order.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.cashTransaction.deleteMany({ where: { shift: { businessId: { in: testIds } } } });
      await tx.cashShift.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.purchaseReceiptItem.deleteMany({ where: { receipt: { businessId: { in: testIds } } } });
      await tx.purchaseReceipt.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.purchaseOrderItem.deleteMany({ where: { po: { businessId: { in: testIds } } } });
      await tx.purchaseOrder.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.vendorReturnItem.deleteMany({ where: { return: { businessId: { in: testIds } } } });
      await tx.vendorReturn.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.openingStockItem.deleteMany({ where: { sheet: { businessId: { in: testIds } } } });
      await tx.openingStockSheet.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.inventoryLedger.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.inventoryBalance.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.productLot.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.variantAttributeValue.deleteMany({ where: { variant: { businessId: { in: testIds } } } });
      await tx.productVariant.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.productTemplate.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.category.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.supplier.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.customer.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.businessMembership.deleteMany({ where: { businessId: { in: testIds } } });
      await tx.businessInvitation.deleteMany({ where: { businessId: { in: testIds } } });

      const deletedBusinesses = await tx.business.deleteMany({
        where: { id: { in: testIds } },
      });
      console.log(`-> Đã xóa thành công ${deletedBusinesses.count} doanh nghiệp test khỏi bảng businesses.`);
    },
    { timeout: 60000 },
  );

  console.log("\n=== DANH SÁCH DOANH NGHIỆP CÒN LẠI TRÊN SUPABASE SAU KHI DỌN DẸP ===");
  const remaining = await prisma.business.findMany({
    select: { id: true, name: true, phone: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.table(
    remaining.map((b, idx) => ({
      STT: idx + 1,
      ID: b.id,
      "Tên Doanh Nghiệp Gốc": b.name,
      SĐT: b.phone,
      "Thời gian tạo": b.createdAt.toISOString(),
    })),
  );

  console.log(`\n=> KẾT LUẬN: ĐÃ DỌN DẸP SẠCH TOÀN BỘ ${testBusinesses.length} TENANT TEST. CHỈ CÒN ĐÚNG ${remaining.length} DOANH NGHIỆP GỐC.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL ERROR cleaning test tenants:", err);
  process.exit(1);
});
