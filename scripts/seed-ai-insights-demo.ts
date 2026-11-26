/**
 * Seeds a clothing + cosmetics catalogue with 60 days of backdated POS orders
 * so the "Cảnh báo tồn kho" page has findings of every kind.
 *
 * Usage: npm run seed:ai-demo -- <demoBusinessId> --confirm-demo-reset
 * Re-running removes previous demo data for that business only after the explicit reset confirmation.
 */
import dotenv from "dotenv";
dotenv.config();
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildDemoLedgerPlan } from "./ai-demo-ledger-plan";

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

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: buildConnectionString(process.env.DATABASE_URL)!,
    ssl: { rejectUnauthorized: false },
  }),
});

const PREFIX = process.env.AI_DEMO_PREFIX ?? "DEMO-AI-";
if (!/^DEMO-[A-Z0-9-]{1,30}-$/.test(PREFIX)) throw new Error("AI_DEMO_PREFIX must be a DEMO- prefix ending with a hyphen.");
const nameSuffix = PREFIX === "DEMO-AI-" ? "" : ` (${PREFIX.slice(0, -1)})`;
const DAY = 86_400_000;

// Noon in Vietnam (05:00 UTC), `daysAgo` days before today
function daysAgoDate(daysAgo: number) {
  const d = new Date(Date.now() + 7 * 60 * 60_000 - daysAgo * DAY);
  d.setUTCHours(5, 0, 0, 0);
  return d;
}

function dateOnly(daysFromToday: number) {
  return new Date(new Date(Date.now() + 7 * 60 * 60_000 + daysFromToday * DAY).toISOString().slice(0, 10));
}

type Lot = { lotNumber: string; expiresInDays: number; qty: number };
type VariantSeed = {
  sku: string;
  size?: string;
  color?: string;
  price: number;
  cost: number;
  stock?: number;
  leadTime?: number;
  safety?: number;
  // units sold on each day offset (1 = yesterday ... 60)
  sales: (daysAgo: number) => number;
  lots?: Lot[];
  expect: string;
};
type ProductSeed = {
  code: string;
  name: string;
  category: string;
  unit: string;
  variants: VariantSeed[];
};

// Deterministic "random" so re-runs give the same data
const pseudo = (d: number, salt: number) => ((d * 31 + salt * 17) % 7) / 7;
const daily = (avg: number, salt: number) => (d: number) =>
  Math.max(0, Math.round(avg + (pseudo(d, salt) - 0.5) * avg * 1.2));

const products: ProductSeed[] = [
  {
    code: "AO-THUN",
    name: "Áo thun cotton cổ tròn",
    category: "Áo",
    unit: "Cái",
    variants: [
      { sku: "AT-TRANG-M", size: "M", color: "Trắng", price: 189000, cost: 95000, stock: 0, leadTime: 5, safety: 6, sales: daily(2, 1), expect: "Sắp hết hàng - CRITICAL (hết hàng, đang bán đều)" },
      { sku: "AT-TRANG-L", size: "L", color: "Trắng", price: 189000, cost: 95000, stock: 14, leadTime: 5, safety: 8, sales: daily(2, 2), expect: "Sắp hết hàng" },
      { sku: "AT-DEN-M", size: "M", color: "Đen", price: 189000, cost: 95000, stock: 60, leadTime: 5, safety: 6, sales: daily(2, 3), expect: "Bình thường" },
    ],
  },
  {
    code: "SOMI",
    name: "Sơ mi công sở tay dài",
    category: "Áo",
    unit: "Cái",
    variants: [
      { sku: "SM-XANH-M", size: "M", color: "Xanh nhạt", price: 329000, cost: 170000, stock: 45, sales: (d) => (d <= 14 ? 0 : d <= 28 ? 1 : 0), expect: "Bán chậm / ít bán" },
      { sku: "SM-TRANG-L", size: "L", color: "Trắng", price: 329000, cost: 170000, stock: 30, sales: () => 0, expect: "Bán chậm - chưa bán được cái nào" },
    ],
  },
  {
    code: "JEAN",
    name: "Quần jean slim-fit co giãn",
    category: "Quần",
    unit: "Cái",
    variants: [
      { sku: "JEAN-XANH-30", size: "30", color: "Xanh đậm", price: 459000, cost: 240000, stock: 90, sales: (d) => (d <= 14 ? 0 : d <= 28 ? 3 : 2), expect: "Doanh số giảm mạnh" },
      { sku: "JEAN-DEN-32", size: "32", color: "Đen", price: 459000, cost: 240000, stock: 25, sales: daily(1, 4), expect: "Bình thường" },
    ],
  },
  {
    code: "VAY",
    name: "Váy midi xếp ly",
    category: "Váy đầm",
    unit: "Cái",
    variants: [
      { sku: "VAY-KEM-S", size: "S", color: "Kem", price: 399000, cost: 200000, stock: 260, sales: daily(1, 5), expect: "Tồn dư (tồn rất nhiều so với tốc độ bán)" },
    ],
  },
  {
    code: "SRM",
    name: "Sữa rửa mặt dịu nhẹ 150ml",
    category: "Chăm sóc da",
    unit: "Chai",
    variants: [
      {
        sku: "SRM-150",
        price: 185000,
        cost: 110000,
        leadTime: 7,
        safety: 10,
        sales: daily(2, 6),
        lots: [
          { lotNumber: `${PREFIX}SRM-L1`, expiresInDays: -4, qty: 6 },
          { lotNumber: `${PREFIX}SRM-L2`, expiresInDays: 25, qty: 70 },
          { lotNumber: `${PREFIX}SRM-L3`, expiresInDays: 300, qty: 40 },
        ],
        expect: "Hết hạn: lô quá hạn còn tồn + lô sắp hết hạn bán không kịp",
      },
    ],
  },
  {
    code: "KCN",
    name: "Kem chống nắng SPF50+ 50g",
    category: "Chăm sóc da",
    unit: "Tuýp",
    variants: [
      {
        sku: "KCN-50",
        price: 265000,
        cost: 160000,
        leadTime: 7,
        safety: 8,
        sales: daily(3, 7),
        lots: [
          { lotNumber: `${PREFIX}KCN-L1`, expiresInDays: 200, qty: 6 },
          { lotNumber: `${PREFIX}KCN-L2`, expiresInDays: 400, qty: 4 },
        ],
        expect: "Sắp hết hàng (tồn 10, bán 3/ngày, nhập 7 ngày)",
      },
    ],
  },
  {
    code: "SON",
    name: "Son kem lì",
    category: "Trang điểm",
    unit: "Thỏi",
    variants: [
      { sku: "SON-DO", color: "Đỏ cherry", price: 219000, cost: 120000, stock: 55, sales: daily(1, 8), expect: "Bình thường" },
    ],
  },
  {
    code: "PHN",
    name: "Phấn nước cushion",
    category: "Trang điểm",
    unit: "Hộp",
    variants: [
      { sku: "PHN-21", color: "Tone 21", price: 349000, cost: 210000, stock: 35, sales: (d) => (d === 50 ? 1 : 0), expect: "Bán chậm - gần như không bán được" },
    ],
  },
];

async function cleanup(businessId: string) {
  await prisma.$transaction((tx) => cleanupInTransaction(tx, businessId), { timeout: 60_000 });
  console.log("Đã xóa dữ liệu demo cũ.");
}

async function cleanupInTransaction(db: Prisma.TransactionClient, businessId: string) {
  const variants = await db.productVariant.findMany({
    where: { businessId, sku: { startsWith: PREFIX } },
    select: { id: true, templateId: true },
  });
  const variantIds = variants.map((v) => v.id);
  const mixedCategories = await db.productTemplate.count({
    where: { businessId, category: { code: { startsWith: PREFIX } }, OR: [{ code: null }, { NOT: { code: { startsWith: PREFIX } } }] },
  });
  if (mixedCategories) throw new Error("Danh mục demo đang được sản phẩm khác sử dụng; không tự động xóa.");
  if (variantIds.length) {
    const orders = await db.order.findMany({
      where: { businessId, orderCode: { startsWith: PREFIX } },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);
    const [nonDemoLedger, otherSales, mixedOrders, otherPurchases, otherSupplierProducts, mixedSuppliers,
      otherSupplierOrders, returns, receipts, audits, scraps] = await Promise.all([
      db.inventoryLedger.count({
      where: {
        businessId,
        variantId: { in: variantIds },
        NOT: {
          OR: [
            { referenceDocType: "DEMO_AI_OPENING", referenceDocId: { in: variantIds } },
            { referenceDocType: "ORDER", referenceDocId: { in: orderIds }, transactionType: "POS_SALE" },
          ],
        },
      },
      }),
      db.orderItem.count({ where: { variantId: { in: variantIds }, order: { NOT: { orderCode: { startsWith: PREFIX } } } } }),
      db.orderItem.count({ where: { orderId: { in: orderIds }, variantId: { notIn: variantIds } } }),
      db.purchaseOrderItem.count({ where: { variantId: { in: variantIds }, po: { NOT: { poCode: { startsWith: PREFIX } } } } }),
      db.supplierProduct.count({ where: { businessId, variantId: { in: variantIds }, supplier: { OR: [{ supplierCode: null }, { NOT: { supplierCode: { startsWith: PREFIX } } }] } } }),
      db.supplierProduct.count({ where: { businessId, variantId: { notIn: variantIds }, supplier: { supplierCode: { startsWith: PREFIX } } } }),
      db.purchaseOrder.count({ where: { businessId, supplier: { supplierCode: { startsWith: PREFIX } }, NOT: { poCode: { startsWith: PREFIX } } } }),
      db.customerReturnItem.count({ where: { variantId: { in: variantIds } } }),
      db.purchaseReceiptItem.count({ where: { variantId: { in: variantIds } } }),
      db.stockAuditItem.count({ where: { variantId: { in: variantIds } } }),
      db.scrapOrder.count({ where: { businessId, variantId: { in: variantIds } } }),
    ]);
    if ([nonDemoLedger, otherSales, mixedOrders, otherPurchases, otherSupplierProducts, mixedSuppliers,
      otherSupplierOrders, returns, receipts, audits, scraps].some((count) => count > 0)) {
      throw new Error("Dữ liệu demo có liên kết hoặc biến động khác; không tự động xóa. Hãy kiểm tra trước khi seed lại.");
    }
    await db.inventoryLedger.deleteMany({ where: { businessId, variantId: { in: variantIds } } });
    await db.orderPayment.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.$executeRaw`DELETE FROM channel_daily_product_metrics WHERE business_id = ${businessId}::uuid AND variant_id = ANY(${variantIds}::uuid[])`;
    await db.aiInsight.deleteMany({ where: { businessId, variantId: { in: variantIds } } });
    await db.aiReplenishmentItem.deleteMany({ where: { businessId, variantId: { in: variantIds } } });
    await db.aiForecast.deleteMany({ where: { businessId, variantId: { in: variantIds } } });
    await db.purchaseOrder.deleteMany({ where: { businessId, poCode: { startsWith: PREFIX } } });
    await db.supplierProduct.deleteMany({ where: { businessId, variantId: { in: variantIds } } });
    await db.supplier.deleteMany({ where: { businessId, supplierCode: { startsWith: PREFIX } } });
    await db.variantAttributeValue.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.inventoryBalance.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.productLotItem.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.productLot.deleteMany({ where: { businessId, lotNumber: { startsWith: PREFIX } } });
    await db.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    await db.productTemplate.deleteMany({
      where: { id: { in: variants.map((v) => v.templateId) } },
    });
  }
  await db.category.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await db.cashShift.deleteMany({ where: { businessId, shiftNotes: `AI_DEMO:${PREFIX}`, orders: { none: {} }, orderPayments: { none: {} }, cashTransactions: { none: {} }, customerReturns: { none: {} } } });
}

async function findOrCreateAttribute(businessId: string, name: string) {
  return (
    (await prisma.attribute.findFirst({ where: { businessId, name } })) ??
    (await prisma.attribute.create({ data: { businessId, name } }))
  );
}

async function findOrCreateValue(businessId: string, attributeId: string, value: string) {
  return (
    (await prisma.attributeValue.findFirst({ where: { businessId, attributeId, value } })) ??
    (await prisma.attributeValue.create({ data: { businessId, attributeId, value } }))
  );
}

// Two suppliers (clothing, cosmetics) with different lead times and pack sizes, plus one open PO that is still on its way
async function seedSuppliers(
  db: Prisma.TransactionClient,
  businessId: string,
  userId: string,
  variants: Array<{ id: string; sku: string; cost: number; cosmetic: boolean }>,
) {
  const defs = [
    { code: `${PREFIX}NCC1`, name: "Xưởng may An Phát (demo)", cosmetic: false, lead: 5, minQty: 6, multiple: 6 },
    { code: `${PREFIX}NCC2`, name: "Mỹ phẩm Hoa Lan (demo)", cosmetic: true, lead: 7, minQty: 12, multiple: 12 },
  ];
  const ids = new Map<boolean, string>();
  for (const def of defs) {
    const supplier = await db.supplier.create({
      data: { businessId, name: `${def.name}${nameSuffix}`, supplierCode: def.code },
    });
    ids.set(def.cosmetic, supplier.id);
    for (const v of variants.filter((item) => item.cosmetic === def.cosmetic)) {
      await db.supplierProduct.create({
        data: {
          businessId,
          supplierId: supplier.id,
          variantId: v.id,
          supplyPrice: new Prisma.Decimal(v.cost),
          minOrderQty: def.minQty,
          orderMultiple: def.multiple,
          leadTimeDays: def.lead,
          isPreferred: true,
        },
      });
    }
  }
  const incoming = variants.find((v) => v.sku.endsWith("AT-TRANG-L"));
  if (incoming) {
    await db.purchaseOrder.create({
      data: {
        businessId,
        poCode: `${PREFIX}PO-0001`,
        supplierId: ids.get(false)!,
        orderDate: dateOnly(-2),
        expectedDeliveryDate: dateOnly(3),
        status: "ORDERED",
        createdBy: userId,
        purchaseOrderItems: { create: [{ variantId: incoming.id, orderedQty: 60, unitPrice: new Prisma.Decimal(incoming.cost) }] },
      },
    });
  }
}

async function resumeSuppliers(businessId: string) {
  const expected = products.flatMap((product) => product.variants.map((v) => ({
    sku: `${PREFIX}${v.sku}`, cost: v.cost,
    cosmetic: product.category !== "Áo" && product.category !== "Quần" && product.category !== "Váy đầm",
    units: Array.from({ length: 60 }, (_, i) => v.sales(i + 1)).reduce((sum, qty) => sum + qty, 0),
    orderCount: Array.from({ length: 60 }, (_, i) => v.sales(i + 1)).filter((qty) => qty > 0).length,
  })));
  const existing = await prisma.productVariant.findMany({ where: { businessId, sku: { startsWith: PREFIX } }, select: { id: true, sku: true } });
  if (existing.length !== expected.length) throw new Error("Bộ sản phẩm demo chưa đầy đủ; không tiếp tục tạo nhà cung cấp.");
  const seeded = expected.map((item) => {
    const variant = existing.find((row) => row.sku === item.sku);
    if (!variant) throw new Error(`Thiếu sản phẩm demo ${item.sku}.`);
    return { ...item, id: variant.id };
  });
  for (const item of seeded) {
    const [orders, ledger, stock] = await Promise.all([
      prisma.orderItem.aggregate({ where: { variantId: item.id, order: { businessId, orderCode: { startsWith: PREFIX } } }, _count: { _all: true }, _sum: { quantity: true } }),
      prisma.inventoryLedger.aggregate({ where: { businessId, variantId: item.id }, _count: { _all: true }, _sum: { quantityChanged: true } }),
      prisma.inventoryBalance.aggregate({ where: { businessId, variantId: item.id }, _sum: { quantityOnHand: true } }),
    ]);
    if (orders._count._all !== item.orderCount || (orders._sum.quantity ?? 0) !== item.units ||
        (ledger._sum.quantityChanged ?? 0) !== (stock._sum.quantityOnHand ?? 0) ||
        (ledger._count._all === 0 && (item.units > 0 || (stock._sum.quantityOnHand ?? 0) > 0))) {
      throw new Error(`Dữ liệu bán hoặc ledger chưa khớp cho ${item.sku}; không tiếp tục.`);
    }
  }
  await prisma.$transaction(async (tx) => {
    if (await tx.supplier.count({ where: { businessId, supplierCode: { startsWith: PREFIX } } })) {
      throw new Error("Đã có nhà cung cấp của bộ demo; kiểm tra thủ công trước khi tiếp tục.");
    }
    const orders = await tx.order.findMany({
      where: { businessId, orderCode: { startsWith: PREFIX } }, select: { id: true, cashierId: true },
    });
    if (!orders.length) throw new Error("Không tìm thấy đơn bán demo.");
    const shift = await tx.cashShift.create({
      data: { businessId, userId: orders[0].cashierId, openedAt: daysAgoDate(61), closedAt: new Date(),
        shiftNotes: `AI_DEMO:${PREFIX}`, openingCash: new Prisma.Decimal(0), status: "CLOSED" },
    });
    const orderIds = orders.map((order) => order.id);
    await tx.orderPayment.updateMany({ where: { orderId: { in: orderIds } }, data: { shiftId: shift.id } });
    await tx.order.updateMany({ where: { businessId, id: { in: orderIds } }, data: { shiftId: shift.id } });
    await seedSuppliers(tx, businessId, shift.userId, seeded);
  }, { timeout: 60_000 });
  console.log("+ 2 nhà cung cấp demo và 1 đơn đặt mua đang về.");
}

async function seedMovements(businessId: string) {
  const created = await prisma.$transaction(async (tx) => {
    const codes = {
      po: `${PREFIX}PO-HISTORY`, receipt: `${PREFIX}RECEIPT-1`, returned: `${PREFIX}RETURN-1`,
      audit: `${PREFIX}AUDIT-1`, scrap: `${PREFIX}SCRAP-1`,
    };
    const existing = await Promise.all([
      tx.purchaseOrder.count({ where: { businessId, poCode: codes.po } }),
      tx.purchaseReceipt.count({ where: { businessId, receiptCode: codes.receipt } }),
      tx.customerReturn.count({ where: { businessId, returnCode: codes.returned } }),
      tx.stockAudit.count({ where: { businessId, auditCode: codes.audit } }),
      tx.scrapOrder.count({ where: { businessId, scrapCode: codes.scrap } }),
    ]);
    if (existing.every((count) => count === 1)) {
      console.log("Các chứng từ biến động demo đã tồn tại; không tạo lại.");
      return false;
    }
    if (existing.some((count) => count > 0)) throw new Error("Bộ chứng từ demo không đầy đủ; cần kiểm tra thủ công trước khi tiếp tục.");

    const variant = await tx.productVariant.findFirst({ where: { businessId, sku: `${PREFIX}AT-TRANG-L` } });
    const supplier = await tx.supplier.findFirst({ where: { businessId, supplierCode: `${PREFIX}NCC1`, isActive: true } });
    const shift = await tx.cashShift.findFirst({ where: { businessId, shiftNotes: `AI_DEMO:${PREFIX}`, status: "CLOSED" } });
    if (!variant || !supplier || !shift) throw new Error("Cần sản phẩm, nhà cung cấp và ca demo trước khi tạo chứng từ biến động.");
    const balance = await tx.inventoryBalance.findFirst({ where: { businessId, variantId: variant.id, lotItemId: null } });
    const original = await tx.orderItem.findFirst({
      where: { variantId: variant.id, order: { businessId, orderCode: { startsWith: PREFIX }, status: "COMPLETED" } },
      include: { order: true },
    });
    const ledger = await tx.inventoryLedger.aggregate({ where: { businessId, variantId: variant.id }, _sum: { quantityChanged: true } });
    if (!balance || !original || (ledger._sum.quantityChanged ?? 0) !== balance.quantityOnHand) {
      throw new Error("Tồn kho, đơn bán hoặc ledger demo không khớp; không tạo chứng từ.");
    }
    const balanceId = balance.id;
    const variantId = variant.id;
    const userId = shift.userId;
    const at = (offset: number) => new Date(Date.now() - 10_000 + offset * 1_000);
    const purchaseTime = at(0);
    const quantity = 6;
    const cost = variant.costPrice;
    const amount = cost.mul(quantity);
    const po = await tx.purchaseOrder.create({
      data: { businessId, poCode: codes.po, supplierId: supplier.id, createdBy: shift.userId,
        orderDate: new Date(new Date(purchaseTime.getTime() + 7 * 60 * 60_000).toISOString().slice(0, 10)), status: "COMPLETED", createdAt: purchaseTime,
        purchaseOrderItems: { create: [{ variantId: variant.id, orderedQty: quantity, receivedQty: quantity, unitPrice: cost }] } },
      include: { purchaseOrderItems: true },
    });
    const receipt = await tx.purchaseReceipt.create({
      data: { businessId, receiptCode: codes.receipt, poId: po.id, supplierId: supplier.id, createdBy: shift.userId,
        receivedAt: purchaseTime, totalAmount: amount, paidAmount: 0, status: "RECEIVED",
        purchaseReceiptItems: { create: [{ poItemId: po.purchaseOrderItems[0].id, variantId: variant.id, receivedQty: quantity, actualCost: cost }] } },
    });
    await tx.supplier.update({ where: { id: supplier.id }, data: { debtAmount: { increment: amount } } });

    let level = balance.quantityOnHand;
    async function move(change: number, type: "PURCHASE_RECEIPT" | "CUSTOMER_RETURN" | "STOCK_ADJUSTMENT_OUT" | "SCRAP_DISPOSAL", referenceDocType: string, referenceDocId: string, timestamp: Date) {
      level += change;
      if (level < 0) throw new Error("Chứng từ demo làm tồn kho âm.");
      await tx.inventoryBalance.update({ where: { id: balanceId }, data: { quantityOnHand: level } });
      await tx.inventoryLedger.create({
        data: { businessId, variantId, transactionType: type, quantityChanged: change, balanceAfter: level,
          unitCost: cost, totalCostValue: cost.mul(Math.abs(change)),
          referenceDocType, referenceDocId, createdBy: userId, createdAt: timestamp },
      });
    }
    await move(quantity, "PURCHASE_RECEIPT", "PURCHASE_RECEIPT", receipt.id, purchaseTime);

    const returnTime = at(1);
    const returned = await tx.customerReturn.create({
      data: { businessId, shiftId: shift.id, cashierId: shift.userId, returnCode: codes.returned,
        originalOrderId: original.orderId, totalRefundAmount: original.unitPrice, refundMethod: "BANK_TRANSFER",
        status: "COMPLETED", createdAt: returnTime,
        customerReturnItems: { create: [{ orderItemId: original.id, variantId: variant.id, returnQty: 1,
          refundUnitPrice: original.unitPrice, refundAmount: original.unitPrice, itemCondition: "RESTOCKABLE", returnReason: "Dữ liệu demo" }] } },
    });
    await move(1, "CUSTOMER_RETURN", "CUSTOMER_RETURN", returned.id, returnTime);

    const auditTime = at(2);
    const audit = await tx.stockAudit.create({
      data: { businessId, auditCode: codes.audit, scopeType: "CATEGORY", auditType: "RE_AUDIT",
        countStartAt: auditTime, completedAt: auditTime, isLockedForAudit: false, status: "DONE",
        createdBy: shift.userId, approvedBy: shift.userId,
        stockAuditItems: { create: [{ variantId: variant.id, snapshotQty: level, countedQty: level - 1, itemStatus: "APPROVED",
          createdBy: shift.userId, approvedBy: shift.userId, approvedAt: auditTime }] } },
    });
    await move(-1, "STOCK_ADJUSTMENT_OUT", "STOCK_AUDIT", audit.id, auditTime);

    const scrapTime = at(3);
    const scrap = await tx.scrapOrder.create({
      data: { businessId, scrapCode: codes.scrap, variantId: variant.id, scrapQty: 1, unitCost: cost,
        totalLossValue: cost, scrapSource: "SELLABLE_STOCK", scrapReason: "Dữ liệu demo", status: "COMPLETED",
        createdBy: shift.userId, approvedBy: shift.userId, createdAt: scrapTime, approvedAt: scrapTime },
    });
    await move(-1, "SCRAP_DISPOSAL", "SCRAP_ORDER", scrap.id, scrapTime);
    await tx.cashShift.update({ where: { id: shift.id }, data: { closedAt: new Date() } });
    return true;
  }, { timeout: 60_000 });
  if (created) console.log("+ Chứng từ nhập, trả, điều chỉnh và xuất hủy cùng ledger demo.");
}

async function main() {
  const businessId = process.argv[2];
  if (!businessId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) {
    throw new Error("Truyền businessId UUID của cửa hàng demo riêng làm tham số; không tự chọn cửa hàng.");
  }
  const resumeSuppliersMode = process.argv.includes("--resume-suppliers");
  const addMovementsMode = process.argv.includes("--add-movements");
  const confirmReset = process.argv.includes("--confirm-demo-reset");
  if (resumeSuppliersMode && addMovementsMode) {
    throw new Error("Chỉ chọn một trong --resume-suppliers hoặc --add-movements.");
  }
  if (confirmReset && (resumeSuppliersMode || addMovementsMode)) {
    throw new Error("--confirm-demo-reset chỉ dùng cho lần seed đầy đủ.");
  }
  if (!resumeSuppliersMode && !addMovementsMode && !confirmReset) {
    throw new Error("Seed đầy đủ sẽ xóa dữ liệu cùng prefix; thêm --confirm-demo-reset để xác nhận.");
  }
  console.log("Cửa hàng:", businessId);

  if (resumeSuppliersMode) {
    await resumeSuppliers(businessId);
    console.log("Đã hoàn tất bộ demo và chuyển đơn bán sang ca demo riêng.");
    return;
  }
  if (addMovementsMode) {
    await seedMovements(businessId);
    return;
  }

  await cleanup(businessId);

  const existingShift = await prisma.cashShift.findFirst({ where: { businessId }, select: { userId: true } });
  const user = existingShift ?? await prisma.user.findFirst({
    where: { memberships: { some: { businessId } } },
    select: { id: true },
  });
  if (!user) throw new Error("Cửa hàng chưa có nhân viên để tạo ca thu ngân demo.");
  const userId = "userId" in user ? user.userId : user.id;
  const shift = await prisma.cashShift.create({
    data: {
      businessId, userId, openedAt: daysAgoDate(61), closedAt: new Date(),
      shiftNotes: `AI_DEMO:${PREFIX}`, openingCash: new Prisma.Decimal(0), status: "CLOSED",
    },
  });

  const sizeAttr = await findOrCreateAttribute(businessId, "Size");
  const colorAttr = await findOrCreateAttribute(businessId, "Màu sắc");

  const categories = new Map<string, string>();
  for (const name of new Set(products.map((p) => p.category))) {
    const c = await prisma.category.create({
      data: { businessId, name: `${name}${nameSuffix}`, code: `${PREFIX}${name.replace(/\s+/g, "").toUpperCase()}` },
    });
    categories.set(name, c.id);
  }

  const createdAt = daysAgoDate(60);
  let orderSeq = 0;
  const seeded: Array<{ id: string; sku: string; cost: number; cosmetic: boolean }> = [];

  for (const p of products) {
    const hasLots = p.variants.some((v) => v.lots);
    const template = await prisma.productTemplate.create({
      data: {
        businessId,
        name: `${p.name}${nameSuffix}`,
        code: `${PREFIX}${p.code}`,
        categoryId: categories.get(p.category),
        unitOfMeasure: p.unit,
        hasLotTracking: hasLots,
        isActive: true,
        createdAt,
      },
    });

    for (const v of p.variants) {
      const sku = `${PREFIX}${v.sku}`;
      const variant = await prisma.productVariant.create({
        data: {
          businessId,
          templateId: template.id,
          sku,
          basePrice: new Prisma.Decimal(v.price),
          costPrice: new Prisma.Decimal(v.cost),
          leadTimeDays: v.leadTime ?? 5,
          safetyStockQty: v.safety ?? 0,
          isActive: true,
          createdAt,
        },
      });

      seeded.push({ id: variant.id, sku, cost: v.cost, cosmetic: p.category !== "Áo" && p.category !== "Quần" && p.category !== "Váy đầm" });

      for (const [attr, value] of [[sizeAttr, v.size], [colorAttr, v.color]] as const) {
        if (!value) continue;
        const av = await findOrCreateValue(businessId, attr.id, value);
        await prisma.variantAttributeValue.create({
          data: { variantId: variant.id, attributeId: attr.id, attributeValueId: av.id },
        });
      }

      const lotItems: { id: string; qty: number }[] = [];
      if (v.lots) {
        for (const l of [...v.lots].sort((a, b) => a.expiresInDays - b.expiresInDays)) {
          const lot = await prisma.productLot.create({
            data: { businessId, lotNumber: l.lotNumber, createdAt },
          });
          const item = await prisma.productLotItem.create({
            data: {
              businessId,
              lotId: lot.id,
              variantId: variant.id,
              manufacturingDate: dateOnly(l.expiresInDays - 730),
              expirationDate: dateOnly(l.expiresInDays),
              status: "HEALTHY",
              createdAt,
            },
          });
          await prisma.inventoryBalance.create({
            data: { businessId, variantId: variant.id, lotItemId: item.id, quantityOnHand: l.qty },
          });
          lotItems.push({ id: item.id, qty: l.qty });
        }
      } else {
        await prisma.inventoryBalance.create({
          data: { businessId, variantId: variant.id, quantityOnHand: v.stock ?? 0 },
        });
      }

      const inventoryLots = lotItems.length
        ? lotItems.map((lot) => ({ lotItemId: lot.id, quantityOnHand: lot.qty }))
        : [{ lotItemId: null, quantityOnHand: v.stock ?? 0 }];
      const saleDays = Array.from({ length: 60 }, (_, index) => {
        const daysAgo = index + 1;
        return { daysAgo, quantity: v.sales(daysAgo) };
      }).filter((sale) => sale.quantity > 0);
      const ledgerPlan = buildDemoLedgerPlan(inventoryLots, saleDays);
      const saleLedgerByDay = new Map(
        ledgerPlan
          .filter((entry) => entry.transactionType === "POS_SALE")
          .map((entry) => [entry.daysAgo, entry] as const),
      );
      for (const entry of ledgerPlan.filter((item) => item.transactionType === "OPENING_STOCK")) {
        await prisma.inventoryLedger.create({
          data: {
            businessId,
            variantId: variant.id,
            lotItemId: entry.lotItemId,
            transactionType: entry.transactionType,
            quantityChanged: entry.quantityChanged,
            balanceAfter: entry.balanceAfter,
            unitCost: new Prisma.Decimal(v.cost),
            totalCostValue: new Prisma.Decimal(v.cost * entry.quantityChanged),
            referenceDocType: "DEMO_AI_OPENING",
            referenceDocId: variant.id,
            createdBy: shift.userId,
            createdAt: daysAgoDate(entry.daysAgo),
          },
        });
      }

      let orderCount = 0;
      for (let d = 60; d >= 1; d--) {
        const qty = v.sales(d);
        if (qty <= 0) continue;
        const ledgerEntry = saleLedgerByDay.get(d);
        if (!ledgerEntry || ledgerEntry.quantityChanged !== -qty) {
          throw new Error(`Lịch sử ledger không khớp doanh số của ${sku} ngày ${d}.`);
        }
        const gross = v.price * qty;
        const cogs = v.cost * qty;
        const order = await prisma.order.create({
          data: {
            businessId,
            shiftId: shift.id,
            cashierId: shift.userId,
            orderCode: `${PREFIX}${String(++orderSeq).padStart(5, "0")}`,
            status: "COMPLETED",
            totalGrossAmount: new Prisma.Decimal(gross),
            totalNetAmount: new Prisma.Decimal(gross),
            totalCogsAmount: new Prisma.Decimal(cogs),
            grossProfit: new Prisma.Decimal(gross - cogs),
            createdAt: daysAgoDate(d),
            orderItems: {
              create: [
                {
                  variantId: variant.id,
                  lotItemId: ledgerEntry.lotItemId,
                  quantity: qty,
                  unitPrice: new Prisma.Decimal(v.price),
                  unitCost: new Prisma.Decimal(v.cost),
                  subtotal: new Prisma.Decimal(gross),
                },
              ],
            },
          },
        });
        await prisma.orderPayment.create({
          data: {
            orderId: order.id,
            shiftId: shift.id,
            paymentMethod: d % 3 === 0 ? "BANK_TRANSFER" : "CASH",
            amount: new Prisma.Decimal(gross),
            createdAt: daysAgoDate(d),
          },
        });
        await prisma.inventoryLedger.create({
          data: {
            businessId, variantId: variant.id, lotItemId: ledgerEntry.lotItemId, transactionType: "POS_SALE",
            quantityChanged: ledgerEntry.quantityChanged, balanceAfter: ledgerEntry.balanceAfter, unitCost: new Prisma.Decimal(v.cost),
            totalCostValue: new Prisma.Decimal(-cogs), referenceDocType: "ORDER", referenceDocId: order.id,
            createdBy: shift.userId, createdAt: daysAgoDate(d),
          },
        });
        orderCount++;
      }
      const plannedFinalStock = inventoryLots.reduce((total, lot) => total + lot.quantityOnHand, 0);
      const initialLedgerStock = ledgerPlan
        .filter((entry) => entry.transactionType === "OPENING_STOCK")
        .reduce((total, entry) => total + entry.quantityChanged, 0);
      if (initialLedgerStock - saleDays.reduce((total, sale) => total + sale.quantity, 0) !== plannedFinalStock) {
        throw new Error(`Lịch sử kho không khớp tồn cuối của ${sku}.`);
      }
      console.log(`+ ${sku}: ${orderCount} đơn - kỳ vọng: ${v.expect}`);
    }
  }

  await prisma.$transaction((tx) => seedSuppliers(tx, businessId, shift.userId, seeded), { timeout: 60_000 });
  console.log("+ 2 nhà cung cấp demo và 1 đơn đặt mua đang về.");
  await seedMovements(businessId);
  console.log("Xong. Mở 'Cảnh báo tồn kho' và bấm 'Phân tích lại', sau đó xem 'Gợi ý nhập hàng'.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
