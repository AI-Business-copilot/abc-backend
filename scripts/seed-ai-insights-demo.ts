/**
 * Seeds a clothing + cosmetics catalogue with 60 days of backdated POS orders
 * so the "Cảnh báo tồn kho" page has findings of every kind.
 *
 * Usage: npm run seed:ai-demo -- [businessId]
 * Re-running first removes the previous demo data (SKU / order code / lot / category prefix DEMO-AI-).
 */
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

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: buildConnectionString(process.env.DATABASE_URL)!,
    ssl: { rejectUnauthorized: false },
  }),
});

const PREFIX = "DEMO-AI-";
const DAY = 86_400_000;

// Noon in Vietnam (05:00 UTC), `daysAgo` days before today
function daysAgoDate(daysAgo: number) {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(5, 0, 0, 0);
  return d;
}

function dateOnly(daysFromToday: number) {
  return new Date(new Date(Date.now() + daysFromToday * DAY).toISOString().slice(0, 10));
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
  const variants = await prisma.productVariant.findMany({
    where: { businessId, sku: { startsWith: PREFIX } },
    select: { id: true, templateId: true },
  });
  const variantIds = variants.map((v) => v.id);
  if (variantIds.length) {
    const orders = await prisma.order.findMany({
      where: { businessId, orderCode: { startsWith: PREFIX } },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);
    await prisma.orderPayment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.$executeRaw`DELETE FROM channel_daily_product_metrics WHERE business_id = ${businessId}::uuid AND variant_id = ANY(${variantIds}::uuid[])`;
    await prisma.aiInsight.deleteMany({ where: { businessId, variantId: { in: variantIds } } });
    await prisma.variantAttributeValue.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.inventoryBalance.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.productLotItem.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.productLot.deleteMany({ where: { businessId, lotNumber: { startsWith: PREFIX } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    await prisma.productTemplate.deleteMany({
      where: { id: { in: variants.map((v) => v.templateId) } },
    });
  }
  await prisma.category.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  console.log("Đã xóa dữ liệu demo cũ.");
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

async function main() {
  const businessId =
    process.argv[2] ||
    (await prisma.productTemplate.findFirst({ select: { businessId: true } }))?.businessId;
  if (!businessId) throw new Error("Không tìm thấy cửa hàng. Truyền businessId làm tham số.");
  console.log("Cửa hàng:", businessId);

  await cleanup(businessId);

  let shift = await prisma.cashShift.findFirst({ where: { businessId } });
  if (!shift) {
    const user = await prisma.user.findFirst({
      where: { memberships: { some: { businessId } } },
    });
    if (!user) throw new Error("Cửa hàng chưa có ca thu ngân nào để gắn đơn demo.");
    shift = await prisma.cashShift.create({
      data: {
        businessId,
        userId: user.id,
        openedAt: daysAgoDate(61),
        openingCash: new Prisma.Decimal(0),
        status: "CLOSED",
      },
    });
  }

  const sizeAttr = await findOrCreateAttribute(businessId, "Size");
  const colorAttr = await findOrCreateAttribute(businessId, "Màu sắc");

  const categories = new Map<string, string>();
  for (const name of new Set(products.map((p) => p.category))) {
    const c = await prisma.category.create({
      data: { businessId, name, code: `${PREFIX}${name.replace(/\s+/g, "").toUpperCase()}` },
    });
    categories.set(name, c.id);
  }

  const createdAt = daysAgoDate(60);
  let orderSeq = 0;

  for (const p of products) {
    const hasLots = p.variants.some((v) => v.lots);
    const template = await prisma.productTemplate.create({
      data: {
        businessId,
        name: p.name,
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

      for (const [attr, value] of [[sizeAttr, v.size], [colorAttr, v.color]] as const) {
        if (!value) continue;
        const av = await findOrCreateValue(businessId, attr.id, value);
        await prisma.variantAttributeValue.create({
          data: { variantId: variant.id, attributeId: attr.id, attributeValueId: av.id },
        });
      }

      const lotItems: { id: string }[] = [];
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
          lotItems.push({ id: item.id });
        }
      } else {
        await prisma.inventoryBalance.create({
          data: { businessId, variantId: variant.id, quantityOnHand: v.stock ?? 0 },
        });
      }

      // Past sales are attributed to the latest-expiring lot, which is still in stock
      const soldFromLot = lotItems.length ? lotItems[lotItems.length - 1].id : null;

      let orderCount = 0;
      for (let d = 60; d >= 1; d--) {
        const qty = v.sales(d);
        if (qty <= 0) continue;
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
                  lotItemId: soldFromLot,
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
        orderCount++;
      }
      console.log(`+ ${sku}: ${orderCount} đơn - kỳ vọng: ${v.expect}`);
    }
  }

  console.log("Xong. Mở 'Cảnh báo tồn kho' và bấm 'Phân tích lại'.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
