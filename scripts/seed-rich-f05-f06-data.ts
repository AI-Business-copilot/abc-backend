import dotenv from "dotenv";
dotenv.config();
import { PrismaClient, Prisma } from "@prisma/client";
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
});
const prisma = new PrismaClient({ adapter });

const BUSINESS_ID = "34344b30-5ac6-4375-9d84-52c993d25ed7"; // Shop thời trang H&X

async function seed() {
  console.log("=== BẮT ĐẦU NẠP DỮ LIỆU TEST PHONG PHÚ CHO F05 & F06 ===");

  // 1. Lấy thông tin user trong cửa hàng
  const ownerUser = await prisma.user.findFirst({
    where: { email: "huongtuti511@gmail.com" },
  });
  if (!ownerUser) {
    throw new Error("Không tìm thấy user huongtuti511@gmail.com!");
  }

  // 2. Mở ca thu ngân nếu chưa có ca OPEN
  let shift = await prisma.cashShift.findFirst({
    where: { businessId: BUSINESS_ID, userId: ownerUser.id, status: "OPEN" },
  });
  if (!shift) {
    shift = await prisma.cashShift.create({
      data: {
        businessId: BUSINESS_ID,
        userId: ownerUser.id,
        openedAt: new Date(),
        openingCash: new Prisma.Decimal(5000000), // 5 triệu tiền đầu ca
        status: "OPEN",
        shiftNotes: "Ca thu ngân test F05 & F06",
      },
    });
    console.log("-> Đã mở ca thu ngân ID:", shift.id);
  } else {
    console.log("-> Đã có ca thu ngân OPEN ID:", shift.id);
  }

  // 3. Tạo Nhà Cung Cấp (Suppliers) kèm công nợ phong phú cho F06
  const suppliersData = [
    {
      name: "Tổng Kho Dệt May Hà Nội",
      phone: "0912345678",
      contactPerson: "Anh Tuấn (Kế toán kho)",
      debtAmount: new Prisma.Decimal(25000000), // Nợ 25 triệu
    },
    {
      name: "Xưởng May & Gia Công Sài Gòn",
      phone: "0987654321",
      contactPerson: "Chị Hạnh (Phụ trách giao hàng)",
      debtAmount: new Prisma.Decimal(12500000), // Nợ 12.5 triệu
    },
    {
      name: "Nhà Phân Phối Phụ Kiện An Khang",
      phone: "0934567890",
      contactPerson: "Anh Bảo (Giám đốc kinh doanh)",
      debtAmount: new Prisma.Decimal(6800000), // Nợ 6.8 triệu
    },
  ];

  const createdSuppliers = [];
  for (const s of suppliersData) {
    let sup = await prisma.supplier.findFirst({
      where: { businessId: BUSINESS_ID, name: s.name },
    });
    if (!sup) {
      sup = await prisma.supplier.create({
        data: {
          businessId: BUSINESS_ID,
          name: s.name,
          phone: s.phone,
          contactPerson: s.contactPerson,
          debtAmount: s.debtAmount,
        },
      });
      console.log(`-> Tạo NCC mới: ${sup.name} (Nợ: ${s.debtAmount} VND)`);
    } else {
      // Cập nhật lại công nợ dương để dễ test
      sup = await prisma.supplier.update({
        where: { id: sup.id },
        data: { debtAmount: s.debtAmount },
      });
      console.log(`-> Đã cập nhật công nợ NCC: ${sup.name} -> ${s.debtAmount} VND`);
    }
    createdSuppliers.push(sup);
  }

  // 4. Tạo Sản Phẩm Thời Trang Thực Tế (Áo thun, Quần jean, Đồ lụa có lô)
  // 4.1. Template Áo Thun
  let tplAoThun = await prisma.productTemplate.findFirst({
    where: { businessId: BUSINESS_ID, name: "Áo Thun Cotton Compact Cổ Tròn" },
  });
  if (!tplAoThun) {
    tplAoThun = await prisma.productTemplate.create({
      data: {
        businessId: BUSINESS_ID,
        name: "Áo Thun Cotton Compact Cổ Tròn",
        code: "TPL-AOTHUN",
        unitOfMeasure: "Cái",
        hasLotTracking: false,
        isActive: true,
      },
    });
  }

  // Variants Áo Thun
  const variantsAoThun = [
    { sku: "AT-COT-TRANG-M", name: "Trắng (Size M)", basePrice: 180000, costPrice: 90000, qty: 35, damaged: 2 },
    { sku: "AT-COT-DEN-L", name: "Đen (Size L)", basePrice: 180000, costPrice: 90000, qty: 28, damaged: 0 },
  ];
  const createdVariants: Record<string, any> = {};

  for (const v of variantsAoThun) {
    let variant = await prisma.productVariant.findFirst({
      where: { businessId: BUSINESS_ID, sku: v.sku },
    });
    if (!variant) {
      variant = await prisma.productVariant.create({
        data: {
          businessId: BUSINESS_ID,
          templateId: tplAoThun.id,
          sku: v.sku,
          basePrice: new Prisma.Decimal(v.basePrice),
          costPrice: new Prisma.Decimal(v.costPrice),
          isActive: true,
          isLockedForAudit: false,
        },
      });
    }
    createdVariants[v.sku] = variant;

    // Tồn kho
    const existingBal = await prisma.inventoryBalance.findFirst({
      where: { businessId: BUSINESS_ID, variantId: variant.id, lotId: null },
    });
    if (existingBal) {
      await prisma.inventoryBalance.update({
        where: { id: existingBal.id },
        data: { quantityOnHand: v.qty, damagedQuantity: v.damaged },
      });
    } else {
      await prisma.inventoryBalance.create({
        data: {
          businessId: BUSINESS_ID,
          variantId: variant.id,
          quantityOnHand: v.qty,
          damagedQuantity: v.damaged,
        },
      });
    }
    console.log(`-> SKU: ${v.sku} - Tồn bán: ${v.qty}, Tồn hỏng: ${v.damaged}`);
  }

  // 4.2. Template Quần Jean
  let tplQuanJean = await prisma.productTemplate.findFirst({
    where: { businessId: BUSINESS_ID, name: "Quần Jean Slimfit Co Giãn" },
  });
  if (!tplQuanJean) {
    tplQuanJean = await prisma.productTemplate.create({
      data: {
        businessId: BUSINESS_ID,
        name: "Quần Jean Slimfit Co Giãn",
        code: "TPL-QUANJEAN",
        unitOfMeasure: "Cái",
        hasLotTracking: false,
        isActive: true,
      },
    });
  }

  const variantsQuanJean = [
    { sku: "QJ-SLIM-XANH-31", name: "Xanh Đậm (Size 31)", basePrice: 450000, costPrice: 220000, qty: 20, damaged: 3 },
    { sku: "QJ-SLIM-XAM-32", name: "Xám Khói (Size 32)", basePrice: 450000, costPrice: 220000, qty: 15, damaged: 0 },
  ];
  for (const v of variantsQuanJean) {
    let variant = await prisma.productVariant.findFirst({
      where: { businessId: BUSINESS_ID, sku: v.sku },
    });
    if (!variant) {
      variant = await prisma.productVariant.create({
        data: {
          businessId: BUSINESS_ID,
          templateId: tplQuanJean.id,
          sku: v.sku,
          basePrice: new Prisma.Decimal(v.basePrice),
          costPrice: new Prisma.Decimal(v.costPrice),
          isActive: true,
          isLockedForAudit: false,
        },
      });
    }
    createdVariants[v.sku] = variant;

    const existingBal = await prisma.inventoryBalance.findFirst({
      where: { businessId: BUSINESS_ID, variantId: variant.id, lotId: null },
    });
    if (existingBal) {
      await prisma.inventoryBalance.update({
        where: { id: existingBal.id },
        data: { quantityOnHand: v.qty, damagedQuantity: v.damaged },
      });
    } else {
      await prisma.inventoryBalance.create({
        data: {
          businessId: BUSINESS_ID,
          variantId: variant.id,
          quantityOnHand: v.qty,
          damagedQuantity: v.damaged,
        },
      });
    }
    console.log(`-> SKU: ${v.sku} - Tồn bán: ${v.qty}, Tồn hỏng: ${v.damaged}`);
  }

  // 4.3. Template Quản lý theo Lô: Bộ Ngủ Lụa
  let tplLua = await prisma.productTemplate.findFirst({
    where: { businessId: BUSINESS_ID, name: "Bộ Đồ Ngủ Lụa Satin (Theo Lô)" },
  });
  if (!tplLua) {
    tplLua = await prisma.productTemplate.create({
      data: {
        businessId: BUSINESS_ID,
        name: "Bộ Đồ Ngủ Lụa Satin (Theo Lô)",
        code: "TPL-LUA",
        unitOfMeasure: "Bộ",
        hasLotTracking: true,
        isActive: true,
      },
    });
  }

  let variantLua = await prisma.productVariant.findFirst({
    where: { businessId: BUSINESS_ID, sku: "BD-LUA-HONG-S" },
  });
  if (!variantLua) {
    variantLua = await prisma.productVariant.create({
      data: {
        businessId: BUSINESS_ID,
        templateId: tplLua.id,
        sku: "BD-LUA-HONG-S",
        basePrice: new Prisma.Decimal(320000),
        costPrice: new Prisma.Decimal(150000),
        isActive: true,
        isLockedForAudit: false,
      },
    });
  }
  createdVariants["BD-LUA-HONG-S"] = variantLua;

  const existingBalLua = await prisma.inventoryBalance.findFirst({
    where: { businessId: BUSINESS_ID, variantId: variantLua.id, lotId: null },
  });
  if (existingBalLua) {
    await prisma.inventoryBalance.update({
      where: { id: existingBalLua.id },
      data: { quantityOnHand: 40, damagedQuantity: 5 },
    });
  } else {
    await prisma.inventoryBalance.create({
      data: {
        businessId: BUSINESS_ID,
        variantId: variantLua.id,
        quantityOnHand: 40,
        damagedQuantity: 5,
      },
    });
  }

  // Tạo 2 Lô hàng: 1 Lô chuẩn bán được, 1 Lô bị cách ly (Quarantined)
  let lotActive = await prisma.productLot.findFirst({
    where: { businessId: BUSINESS_ID, variantId: variantLua.id, lotNumber: "LOT-LUA-2026-A1" },
  });
  if (!lotActive) {
    lotActive = await prisma.productLot.create({
      data: {
        businessId: BUSINESS_ID,
        variantId: variantLua.id,
        lotNumber: "LOT-LUA-2026-A1",
        manufacturingDate: new Date("2026-01-01"),
        expirationDate: new Date("2028-12-31"),
        status: "HEALTHY",
      },
    });
    console.log(`-> Tạo Lô bán được: ${lotActive.lotNumber} (HSD: 2028-12-31)`);
  }

  let lotQuarantined = await prisma.productLot.findFirst({
    where: { businessId: BUSINESS_ID, variantId: variantLua.id, lotNumber: "LOT-LUA-2026-ERR" },
  });
  if (!lotQuarantined) {
    lotQuarantined = await prisma.productLot.create({
      data: {
        businessId: BUSINESS_ID,
        variantId: variantLua.id,
        lotNumber: "LOT-LUA-2026-ERR",
        manufacturingDate: new Date("2026-01-01"),
        expirationDate: new Date("2028-12-31"),
        status: "QUARANTINED",
        quarantineQty: 5,
        quarantinedAt: new Date(),
        quarantinedBy: ownerUser.id,
      },
    });
    console.log(`-> Tạo Lô cách ly lỗi: ${lotQuarantined.lotNumber} (Cách ly: 5 bộ)`);
  }

  // 5. Tạo Phiếu Nhập Kho Mẫu (Purchase Receipt) từ NCC Hà Nội để test F06
  let sampleReceipt = await prisma.purchaseReceipt.findFirst({
    where: { businessId: BUSINESS_ID, receiptCode: "REC-DEMO-F06-001" },
  });
  if (!sampleReceipt) {
    sampleReceipt = await prisma.purchaseReceipt.create({
      data: {
        businessId: BUSINESS_ID,
        supplierId: createdSuppliers[0].id,
        receiptCode: "REC-DEMO-F06-001",
        status: "RECEIVED",
        totalAmount: new Prisma.Decimal(4500000),
        paidAmount: new Prisma.Decimal(0),
        createdBy: ownerUser.id,
        purchaseReceiptItems: {
          create: [
            {
              variantId: createdVariants["AT-COT-TRANG-M"].id,
              receivedQty: 50,
              actualCost: new Prisma.Decimal(90000),
            },
          ],
        },
      },
    });
    console.log(`-> Tạo Phiếu Nhập Kho NCC: ${sampleReceipt.receiptCode}`);
  }

  // 6. Tạo Các Đơn Hàng Mẫu POS (Orders) để test Khách Trả & Đổi hàng (F05)
  // Đơn 1: Mua 5 áo thun trắng, chưa trả cái nào -> Rất dễ test trả 1 hoặc 2 cái
  const order1Code = "ORD-F05-DEMO-01";
  let order1 = await prisma.order.findFirst({
    where: { businessId: BUSINESS_ID, orderCode: order1Code },
  });
  if (!order1) {
    order1 = await prisma.order.create({
      data: {
        businessId: BUSINESS_ID,
        shiftId: shift.id,
        cashierId: ownerUser.id,
        orderCode: order1Code,
        status: "COMPLETED",
        totalGrossAmount: new Prisma.Decimal(900000), // 5 * 180,000
        discountAmount: new Prisma.Decimal(0),
        totalNetAmount: new Prisma.Decimal(900000),
        totalCogsAmount: new Prisma.Decimal(450000), // 5 * 90,000
        grossProfit: new Prisma.Decimal(450000),
        orderItems: {
          create: [
            {
              variantId: createdVariants["AT-COT-TRANG-M"].id,
              quantity: 5,
              unitPrice: new Prisma.Decimal(180000),
              unitCost: new Prisma.Decimal(90000),
              discountAmount: new Prisma.Decimal(0),
              subtotal: new Prisma.Decimal(900000),
            },
          ],
        },
      },
    });
    console.log(`-> Tạo Đơn hàng 1: ${order1.orderCode} (Mua 5 áo AT-COT-TRANG-M, tổng 900.000đ)`);
  }

  // Đơn 2: Mua 2 quần Jean + 2 bộ ngủ lụa -> Test trả nhiều mặt hàng hoặc đổi hàng bù tiền
  const order2Code = "ORD-F05-DEMO-02";
  let order2 = await prisma.order.findFirst({
    where: { businessId: BUSINESS_ID, orderCode: order2Code },
  });
  if (!order2) {
    order2 = await prisma.order.create({
      data: {
        businessId: BUSINESS_ID,
        shiftId: shift.id,
        cashierId: ownerUser.id,
        orderCode: order2Code,
        status: "COMPLETED",
        totalGrossAmount: new Prisma.Decimal(1540000), // 2*450k + 2*320k
        discountAmount: new Prisma.Decimal(0),
        totalNetAmount: new Prisma.Decimal(1540000),
        totalCogsAmount: new Prisma.Decimal(740000), // 2*220k + 2*150k
        grossProfit: new Prisma.Decimal(800000),
        orderItems: {
          create: [
            {
              variantId: createdVariants["QJ-SLIM-XANH-31"].id,
              quantity: 2,
              unitPrice: new Prisma.Decimal(450000),
              unitCost: new Prisma.Decimal(220000),
              discountAmount: new Prisma.Decimal(0),
              subtotal: new Prisma.Decimal(900000),
            },
            {
              variantId: createdVariants["BD-LUA-HONG-S"].id,
              lotId: lotActive?.id,
              quantity: 2,
              unitPrice: new Prisma.Decimal(320000),
              unitCost: new Prisma.Decimal(150000),
              discountAmount: new Prisma.Decimal(0),
              subtotal: new Prisma.Decimal(640000),
            },
          ],
        },
      },
    });
    console.log(`-> Tạo Đơn hàng 2: ${order2.orderCode} (Mua 2 Quần Jean + 2 Bộ Lụa, tổng 1.540.000đ)`);
  }

  // Đơn 3: Mua 4 áo thun đen, đã từng trả 1 cái trước đó -> Còn 3 cái (Test lũy kế)
  const order3Code = "ORD-F05-DEMO-03";
  let order3 = await prisma.order.findFirst({
    where: { businessId: BUSINESS_ID, orderCode: order3Code },
    include: { orderItems: true },
  });
  if (!order3) {
    order3 = await prisma.order.create({
      data: {
        businessId: BUSINESS_ID,
        shiftId: shift.id,
        cashierId: ownerUser.id,
        orderCode: order3Code,
        status: "COMPLETED",
        totalGrossAmount: new Prisma.Decimal(720000), // 4 * 180,000
        discountAmount: new Prisma.Decimal(0),
        totalNetAmount: new Prisma.Decimal(720000),
        totalCogsAmount: new Prisma.Decimal(360000),
        grossProfit: new Prisma.Decimal(360000),
        orderItems: {
          create: [
            {
              variantId: createdVariants["AT-COT-DEN-L"].id,
              quantity: 4,
              unitPrice: new Prisma.Decimal(180000),
              unitCost: new Prisma.Decimal(90000),
              discountAmount: new Prisma.Decimal(0),
              subtotal: new Prisma.Decimal(720000),
            },
          ],
        },
      },
      include: { orderItems: true },
    });
    console.log(`-> Tạo Đơn hàng 3: ${order3.orderCode} (Mua 4 áo đen AT-COT-DEN-L, tổng 720.000đ)`);

    // Tạo sẵn 1 phiếu trả 1 cái trong quá khứ để test lũy kế
    await prisma.customerReturn.create({
      data: {
        businessId: BUSINESS_ID,
        shiftId: shift.id,
        cashierId: ownerUser.id,
        returnCode: "RET-HIST-001",
        originalOrderId: order3.id,
        isUnverifiedOrigin: false,
        totalRefundAmount: new Prisma.Decimal(180000),
        refundMethod: "CASH",
        status: "COMPLETED",
        customerReturnItems: {
          create: [
            {
              orderItemId: order3.orderItems[0].id,
              variantId: createdVariants["AT-COT-DEN-L"].id,
              returnQty: 1,
              refundUnitPrice: new Prisma.Decimal(180000),
              itemCondition: "RESTOCKABLE",
              returnReason: "Khách đổi ý trả bớt 1 chiếc",
            },
          ],
        },
      },
    });
    console.log(`   -> Đã gắn phiếu trả lịch sử RET-HIST-001 (Đã trả 1, còn được trả 3)`);
  }

  // 7. Tạo sẵn 1 Phiếu Trả NCC mẫu trong lịch sử để Tab "Lịch sử đổi trả" có dữ liệu ngay
  const vretCode = "VRET-HIST-001";
  const existingVret = await prisma.vendorReturn.findFirst({
    where: { businessId: BUSINESS_ID, returnCode: vretCode },
  });
  if (!existingVret) {
    await prisma.vendorReturn.create({
      data: {
        businessId: BUSINESS_ID,
        supplierId: createdSuppliers[0].id,
        returnCode: vretCode,
        totalReturnValue: new Prisma.Decimal(450000),
        status: "COMPLETED",
        createdBy: ownerUser.id,
        vendorReturnItems: {
          create: [
            {
              variantId: createdVariants["AT-COT-TRANG-M"].id,
              returnQty: 5,
              returnUnitPrice: new Prisma.Decimal(90000),
            },
          ],
        },
      },
    });
    console.log(`-> Tạo Phiếu trả NCC lịch sử mẫu: ${vretCode} (Trị giá: 450.000đ)`);
  }

  console.log("=== HOÀN TẤT NẠP DỮ LIỆU TEST F05 - F06 THÀNH CÔNG ===");
}

seed()
  .catch((e) => {
    console.error("Lỗi khi seed dữ liệu:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
