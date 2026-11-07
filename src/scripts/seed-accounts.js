const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

function buildConnectionString(raw) {
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
  connectionString: buildConnectionString(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const prisma = new PrismaClient({ adapter });

function computeEan13Checksum(code12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(code12[i], 10);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const mod = sum % 10;
  return mod === 0 ? 0 : 10 - mod;
}

function generateEan13(prefix = "8935") {
  const rand = String(Math.floor(10000000 + Math.random() * 90000000)).slice(0, 8);
  const code12 = `${prefix}${rand}`;
  return `${code12}${computeEan13Checksum(code12)}`;
}

async function ensureSupabaseUser(email, password, fullName) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  });

  const data = await res.json();
  const existing = (data.users || []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (existing) {
    console.log(`Supabase auth user exists: ${email} (${existing.id})`);
    return existing.id;
  }

  const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to create user in Supabase: ${createRes.status} ${errText}`);
  }

  const created = await createRes.json();
  console.log(`Created Supabase auth user: ${email} (${created.id})`);
  return created.id;
}

async function main() {
  console.log("=== BẮT ĐẦU SEED DỮ LIỆU ĐỘC LẬP CHO 2 CỬA HÀNG ===");

  const ownerRole = await prisma.role.findFirst({ where: { code: "OWNER" } });
  if (!ownerRole) throw new Error("Owner role not found");

  // =========================================================================
  // 1. TÀI KHOẢN 2: normaluser2@gmail.com - MỸ PHẨM VINASON (COSMETICS)
  // =========================================================================
  console.log("\n--- [1] Cấu hình Cửa hàng Mỹ phẩm Vinason (normaluser2@gmail.com) ---");
  const authUserId2 = await ensureSupabaseUser(
    "normaluser2@gmail.com",
    "Password123!",
    "Nguyễn Thu Hà"
  );

  let user2 = await prisma.user.findFirst({
    where: { OR: [{ email: "normaluser2@gmail.com" }, { authUserId: authUserId2 }] },
  });

  if (!user2) {
    user2 = await prisma.user.create({
      data: {
        email: "normaluser2@gmail.com",
        fullName: "Nguyễn Thu Hà",
        authUserId: authUserId2,
        isActive: true,
      },
    });
    console.log(`Đã tạo User record cho normaluser2@gmail.com (id: ${user2.id})`);
  }

  let business2 = await prisma.business.findFirst({
    where: { name: "Mỹ phẩm Vinason" },
  });

  if (!business2) {
    business2 = await prisma.business.create({
      data: {
        name: "Mỹ phẩm Vinason",
        industryType: "COSMETICS",
        address: "128 Hai Bà Trưng, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh",
        phone: "0912345678",
      },
    });
    console.log(`Đã tạo Business 'Mỹ phẩm Vinason' (id: ${business2.id})`);
  }

  // Membership
  const membership2 = await prisma.businessMembership.findFirst({
    where: { businessId: business2.id, userId: user2.id },
  });
  if (!membership2) {
    await prisma.businessMembership.create({
      data: {
        businessId: business2.id,
        userId: user2.id,
        roleId: ownerRole.id,
        status: "ACTIVE",
      },
    });
    console.log("Đã gán quyền OWNER cho normaluser2@gmail.com tại Mỹ phẩm Vinason");
  }

  // Cosmetics Categories
  const cosmeticsCatDefs = [
    { code: "CAT-SER", name: "Serum & Tinh Chất", description: "Các dòng serum phục hồi, cấp ẩm chuyên sâu" },
    { code: "CAT-SUN", name: "Kem Chống Nắng", description: "Chống nắng quang phổ rộng, kiềm dầu" },
    { code: "CAT-CLN", name: "Tẩy Trang & Làm Sạch", description: "Nước tẩy trang dịu nhẹ, sữa rửa mặt" },
    { code: "CAT-LIP", name: "Son Môi & Trang Điểm", description: "Son kem lì, son dưỡng môi tự nhiên" },
    { code: "CAT-CRM", name: "Kem Dưỡng Da", description: "Kem dưỡng ẩm và phục hồi tái tạo ban đêm" },
  ];

  const cosmeticsCats = {};
  for (const cat of cosmeticsCatDefs) {
    let c = await prisma.category.findFirst({
      where: { businessId: business2.id, name: cat.name },
    });
    if (!c) {
      c = await prisma.category.create({
        data: {
          businessId: business2.id,
          name: cat.name,
          code: cat.code,
          description: cat.description,
          isActive: true,
        },
      });
    }
    cosmeticsCats[cat.code] = c;
  }

  // Cosmetics Attributes
  let attrVolume = await prisma.attribute.findFirst({
    where: { businessId: business2.id, name: "Dung tích / Trọng lượng" },
  });
  if (!attrVolume) {
    attrVolume = await prisma.attribute.create({
      data: { businessId: business2.id, name: "Dung tích / Trọng lượng" },
    });
  }

  let attrColorCos = await prisma.attribute.findFirst({
    where: { businessId: business2.id, name: "Màu sắc" },
  });
  if (!attrColorCos) {
    attrColorCos = await prisma.attribute.create({
      data: { businessId: business2.id, name: "Màu sắc" },
    });
  }

  async function getValCos(attrId, value) {
    let v = await prisma.attributeValue.findFirst({
      where: { attributeId: attrId, value },
    });
    if (!v) {
      v = await prisma.attributeValue.create({
        data: { businessId: business2.id, attributeId: attrId, value },
      });
    }
    return v;
  }

  const v30ml = await getValCos(attrVolume.id, "30ml");
  const v50ml = await getValCos(attrVolume.id, "50ml");
  const v400ml = await getValCos(attrVolume.id, "400ml");
  const v50g = await getValCos(attrVolume.id, "50g");

  const vDoCam = await getValCos(attrColorCos.id, "Đỏ Cam");
  const vDoDat = await getValCos(attrColorCos.id, "Đỏ Đất");
  const vHongDat = await getValCos(attrColorCos.id, "Hồng Đất");

  // 5 High Quality Cosmetics Products with FEFO / Lot Tracking
  const cosmeticsProducts = [
    {
      code: "TMP-SER-B5",
      name: "Serum Phục Hồi Da B5 & HA Vinason",
      categoryId: cosmeticsCats["CAT-SER"].id,
      unitOfMeasure: "Hộp",
      description: "Serum chứa 5% Vitamin B5 (Panthenol) và Hyaluronic Acid đa phân tử giúp cấp ẩm sâu và làm dịu da nhạy cảm.",
      hasLotTracking: true,
      images: [
        "https://images.unsplash.com/photo-1620916566398-39f1143ab7be?auto=format&fit=crop&w=800&q=80",
        "https://images.unsplash.com/photo-1608248597359-323864a6639a?auto=format&fit=crop&w=800&q=80",
      ],
      variants: [
        {
          sku: "VNS-SERUMB5-30ML-V1",
          attrVal: v30ml,
          cost: 160000,
          price: 290000,
          stock: 120,
          lot: "LOT-2026-B5-01",
          mfg: "2026-01-15",
          exp: "2028-12-31",
        },
        {
          sku: "VNS-SERUMB5-50ML-V1",
          attrVal: v50ml,
          cost: 230000,
          price: 420000,
          stock: 85,
          lot: "LOT-2026-B5-02",
          mfg: "2026-01-20",
          exp: "2028-12-31",
        },
      ],
    },
    {
      code: "TMP-SUN-SPF50",
      name: "Kem Chống Nắng Kiềm Dầu SPF50+ PA++++",
      categoryId: cosmeticsCats["CAT-SUN"].id,
      unitOfMeasure: "Tuýp",
      description: "Kem chống nắng quang phổ rộng bảo vệ da hoàn hảo trước tia UVA/UVB, kiểm soát bã nhờn suốt 8 giờ.",
      hasLotTracking: true,
      images: [
        "https://images.unsplash.com/photo-1598440947619-2c35fc9aa908?auto=format&fit=crop&w=800&q=80",
        "https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80",
      ],
      variants: [
        {
          sku: "VNS-SUNSC-50ML-V1",
          attrVal: v50ml,
          cost: 145000,
          price: 265000,
          stock: 150,
          lot: "LOT-2026-SUN-02",
          mfg: "2026-02-10",
          exp: "2027-06-30",
        },
      ],
    },
    {
      code: "TMP-CLN-MIC400",
      name: "Nước Tẩy Trang Dịu Nhẹ Micellar Water 400ml",
      categoryId: cosmeticsCats["CAT-CLN"].id,
      unitOfMeasure: "Chai",
      description: "Công nghệ micellar hút sạch bụi mịn và lớp trang điểm chống trôi mà không gây khô rát hay cay mắt.",
      hasLotTracking: true,
      images: [
        "https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80",
        "https://images.unsplash.com/photo-1620916566398-39f1143ab7be?auto=format&fit=crop&w=800&q=80",
      ],
      variants: [
        {
          sku: "VNS-MICELL-400ML-V1",
          attrVal: v400ml,
          cost: 110000,
          price: 215000,
          stock: 200,
          lot: "LOT-2026-MIC-01",
          mfg: "2026-01-20",
          exp: "2028-05-15",
        },
      ],
    },
    {
      code: "TMP-LIP-VELVET",
      name: "Son Kem Lì Velvet Lip Tint Vinason",
      categoryId: cosmeticsCats["CAT-LIP"].id,
      unitOfMeasure: "Thỏi",
      description: "Chất son velvet xốp mịn, che phủ rãnh môi tự nhiên, chuẩn màu tôn da châu Á suốt cả ngày dài.",
      hasLotTracking: true,
      images: [
        "https://images.unsplash.com/photo-1586495777744-4413f21062fa?auto=format&fit=crop&w=800&q=80",
        "https://images.unsplash.com/photo-1631214524020-7e18db9a8f92?auto=format&fit=crop&w=800&q=80",
      ],
      variants: [
        {
          sku: "VNS-LIPTNT-DOCAM-V1",
          attrVal: vDoCam,
          cost: 95000,
          price: 185000,
          stock: 60,
          lot: "LOT-2026-LIP-01",
          mfg: "2026-03-01",
          exp: "2028-08-30",
        },
        {
          sku: "VNS-LIPTNT-DODAT-V1",
          attrVal: vDoDat,
          cost: 95000,
          price: 185000,
          stock: 75,
          lot: "LOT-2026-LIP-02",
          mfg: "2026-03-01",
          exp: "2028-08-30",
        },
        {
          sku: "VNS-LIPTNT-HONGDAT-V1",
          attrVal: vHongDat,
          cost: 95000,
          price: 185000,
          stock: 90,
          lot: "LOT-2026-LIP-03",
          mfg: "2026-03-01",
          exp: "2028-08-30",
        },
      ],
    },
    {
      code: "TMP-CRM-NIGHT50",
      name: "Kem Dưỡng Trắng & Tái Tạo Da Ban Đêm 50g",
      categoryId: cosmeticsCats["CAT-CRM"].id,
      unitOfMeasure: "Hũ",
      description: "Chứa Niacinamide 4% và Ceramide Complex phục hồi hàng rào ẩm, dưỡng trắng sáng đều màu da sau 4 tuần.",
      hasLotTracking: true,
      images: [
        "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80",
        "https://images.unsplash.com/photo-1620916566398-39f1143ab7be?auto=format&fit=crop&w=800&q=80",
      ],
      variants: [
        {
          sku: "VNS-CREAM-50G-V1",
          attrVal: v50g,
          cost: 190000,
          price: 360000,
          stock: 110,
          lot: "LOT-2026-CRM-03",
          mfg: "2026-02-25",
          exp: "2027-11-20",
        },
      ],
    },
  ];

  const cosmeticsVoucherItems = [];

  for (const p of cosmeticsProducts) {
    let t = await prisma.productTemplate.findFirst({
      where: { businessId: business2.id, code: p.code },
    });

    const imageUrl = JSON.stringify(p.images);

    if (!t) {
      t = await prisma.productTemplate.create({
        data: {
          businessId: business2.id,
          name: p.name,
          code: p.code,
          description: p.description,
          categoryId: p.categoryId,
          unitOfMeasure: p.unitOfMeasure,
          hasLotTracking: true,
          imageUrl,
          isActive: true,
        },
      });
      console.log(`+ Đã tạo mẫu mỹ phẩm: ${p.name}`);
    } else {
      await prisma.productTemplate.update({
        where: { id: t.id },
        data: { imageUrl, name: p.name, description: p.description, hasLotTracking: true },
      });
    }

    for (const v of p.variants) {
      let variant = await prisma.productVariant.findFirst({
        where: { businessId: business2.id, sku: v.sku },
      });

      if (!variant) {
        variant = await prisma.productVariant.create({
          data: {
            businessId: business2.id,
            templateId: t.id,
            sku: v.sku,
            barcode: generateEan13("8936001"),
            basePrice: v.price,
            costPrice: v.cost,
            safetyStockQty: 10,
            isActive: true,
          },
        });
      }

      // Link attribute value
      const existingLink = await prisma.variantAttributeValue.findFirst({
        where: { variantId: variant.id, attributeId: v.attrVal.attributeId },
      });
      if (!existingLink) {
        await prisma.variantAttributeValue.create({
          data: {
            variantId: variant.id,
            attributeId: v.attrVal.attributeId,
            attributeValueId: v.attrVal.id,
          },
        });
      }

      // Create ProductLot
      let lot = await prisma.productLot.findFirst({
        where: { businessId: business2.id, variantId: variant.id, lotNumber: v.lot },
      });
      if (!lot) {
        lot = await prisma.productLot.create({
          data: {
            businessId: business2.id,
            variantId: variant.id,
            lotNumber: v.lot,
            manufacturingDate: new Date(v.mfg),
            expirationDate: new Date(v.exp),
            status: "HEALTHY",
          },
        });
      }

      // InventoryBalance with lot
      let balance = await prisma.inventoryBalance.findFirst({
        where: { businessId: business2.id, variantId: variant.id, lotId: lot.id },
      });
      if (!balance) {
        await prisma.inventoryBalance.create({
          data: {
            businessId: business2.id,
            variantId: variant.id,
            lotId: lot.id,
            quantityOnHand: v.stock,
          },
        });
      } else {
        await prisma.inventoryBalance.update({
          where: { id: balance.id },
          data: { quantityOnHand: v.stock },
        });
      }

      cosmeticsVoucherItems.push({
        variantId: variant.id,
        lotId: lot.id,
        quantity: v.stock,
        unitCost: v.cost,
      });
    }
  }

  // Create OpeningStockSheet for Vinason
  const existingSheet2 = await prisma.openingStockSheet.findFirst({
    where: { businessId: business2.id, code: "OSTK-VNS-2026-001" },
  });
  if (!existingSheet2 && cosmeticsVoucherItems.length > 0) {
    const sheet2 = await prisma.openingStockSheet.create({
      data: {
        businessId: business2.id,
        createdBy: user2.id,
        code: "OSTK-VNS-2026-001",
        note: "Phiếu kiểm kê nạp tồn kho ban đầu khi khai trương Mỹ phẩm Vinason",
        status: "APPLIED",
        appliedAt: new Date(),
        openingStockItems: {
          create: cosmeticsVoucherItems.map((it) => ({
            variantId: it.variantId,
            lotId: it.lotId,
            quantity: it.quantity,
            unitCost: it.unitCost,
          })),
        },
      },
    });
    console.log(`Đã tạo phiếu kiểm kê nạp tồn kho ${sheet2.code} cho Mỹ phẩm Vinason`);
  }

  // =========================================================================
  // 2. TÀI KHOẢN 1: normaluser@gmail.com - CỬA HÀNG THỜI TRANG VINACLOTHES
  // =========================================================================
  console.log("\n--- [2] Dọn dẹp & Chuẩn hóa Cửa hàng Thời trang Vinaclothes (normaluser@gmail.com) ---");
  const business1Id = "bede1384-54ea-4631-a921-bc33f5cfd0a5";
  const user1 = await prisma.user.findFirst({ where: { email: "normaluser@gmail.com" } });
  if (!user1) throw new Error("normaluser@gmail.com user not found");

  // Xóa các sản phẩm test / tạp hóa không thuộc thời trang
  const nonFashionCodes = [
    "TMP-MISC-SET01",
    "TMP-MISC-GIFT01",
    "TMP-MISC-BTL01",
    "TMP-MISC-LMP01",
    "TMP-MISC-KIT01",
    "TMP-2026-0001",
    "TMP-2026-0003",
    "TMP-MISC-SCF01",
  ];
  const deleteResult = await prisma.productTemplate.deleteMany({
    where: {
      businessId: business1Id,
      code: { in: nonFashionCodes },
    },
  });
  console.log(`Đã dọn dẹp ${deleteResult.count} sản phẩm tạp phẩm / linh tinh khỏi Vinaclothes.`);

  // Xóa danh mục mỹ phẩm khỏi Vinaclothes nếu có
  await prisma.category.deleteMany({
    where: {
      businessId: business1Id,
      name: { in: ["Mỹ phẩm", "Chăm sóc da", "Trang điểm", "Nước hoa", "test", "test1"] },
      productTemplates: { none: {} },
    },
  });

  // Setup Standard Fashion Categories
  const fashionCategoryDefs = [
    { code: "CAT-AOH", name: "Áo Hoodie & Sweatshirt", description: "Áo hoodie nỉ bông, form rộng unisex" },
    { code: "CAT-AOT", name: "Áo Thun & T-Shirt", description: "Áo thun cotton compact cổ tròn basic" },
    { code: "CAT-AOS", name: "Áo Sơ Mi Nam Nữ", description: "Áo sơ mi dài tay Oxford, sơ mi cổ bẻ" },
    { code: "CAT-QUA", name: "Quần Jean & Denim", description: "Quần jean ống suông, slimfit co giãn" },
    { code: "CAT-BAL", name: "Balo & Túi Đeo Chéo", description: "Balo laptop chống nước, túi đeo chéo unisex" },
    { code: "CAT-SNE", name: "Giày Sneaker Thể Thao", description: "Giày sneaker thể thao phong cách retro streetstyle" },
    { code: "CAT-SAN", name: "Dép & Sandal Thời Trang", description: "Sandal quai ngang êm chân, dép quai hậu" },
    { code: "CAT-NON", name: "Nón & Mũ Lưỡi Trai", description: "Nón kết vintage thêu logo, nón bóng chày" },
    { code: "CAT-TLG", name: "Thắt Lưng Da", description: "Thắt lưng da bò cao cấp khóa kim chống gỉ" },
    { code: "CAT-KIN", name: "Kính Mát Thời Trang", description: "Kính râm phân cực chống tia UV400" },
    { code: "CAT-TAT", name: "Vớ & Tất Cotton", description: "Vớ cổ trung dệt kim kháng khuẩn khử mùi" },
  ];

  const fashionCats = {};
  for (const c of fashionCategoryDefs) {
    let cat = await prisma.category.findFirst({
      where: { businessId: business1Id, OR: [{ code: c.code }, { name: c.name }] },
    });
    if (!cat) {
      cat = await prisma.category.create({
        data: {
          businessId: business1Id,
          name: c.name,
          code: c.code,
          description: c.description,
          isActive: true,
        },
      });
    } else {
      cat = await prisma.category.update({
        where: { id: cat.id },
        data: { name: c.name, description: c.description, isActive: true },
      });
    }
    fashionCats[c.code] = cat;
  }

  // Attributes for Fashion
  let attrColor = await prisma.attribute.findFirst({
    where: { businessId: business1Id, name: "Màu sắc" },
  });
  if (!attrColor) {
    attrColor = await prisma.attribute.create({
      data: { businessId: business1Id, name: "Màu sắc" },
    });
  }

  let attrSize = await prisma.attribute.findFirst({
    where: { businessId: business1Id, name: "Kích cỡ" },
  });
  if (!attrSize) {
    attrSize = await prisma.attribute.create({
      data: { businessId: business1Id, name: "Kích cỡ" },
    });
  }

  async function getValFash(attrId, value) {
    let v = await prisma.attributeValue.findFirst({
      where: { attributeId: attrId, value },
    });
    if (!v) {
      v = await prisma.attributeValue.create({
        data: { businessId: business1Id, attributeId: attrId, value },
      });
    }
    return v;
  }

  // Color values
  const cDen = await getValFash(attrColor.id, "Đen");
  const cTrang = await getValFash(attrColor.id, "Trắng");
  const cXam = await getValFash(attrColor.id, "Xám");
  const cBe = await getValFash(attrColor.id, "Be");
  const cXanhNavy = await getValFash(attrColor.id, "Xanh Navy");
  const cNau = await getValFash(attrColor.id, "Nâu");
  const cGongVang = await getValFash(attrColor.id, "Gọng Vàng");
  const cMix = await getValFash(attrColor.id, "Set 3 Màu");

  // Size values
  const sS = await getValFash(attrSize.id, "S");
  const sM = await getValFash(attrSize.id, "M");
  const sL = await getValFash(attrSize.id, "L");
  const sXL = await getValFash(attrSize.id, "XL");
  const s29 = await getValFash(attrSize.id, "Size 29");
  const s30 = await getValFash(attrSize.id, "Size 30");
  const s31 = await getValFash(attrSize.id, "Size 31");
  const s40 = await getValFash(attrSize.id, "Size 40");
  const s41 = await getValFash(attrSize.id, "Size 41");
  const s42 = await getValFash(attrSize.id, "Size 42");
  const sTieuChuan = await getValFash(attrSize.id, "Tiêu chuẩn");
  const sFree = await getValFash(attrSize.id, "Freesize");

  // 11 Flagship Fashion & Accessories Products with 100% Matching Unsplash Photos
  // Standard SKU: [BRAND]-[CODE]-[VOL]-[VER] => e.g. VNC-HOODIE-BLK-M
  const flagshipFashionProducts = [
    {
      code: "TMP-HOODIE-UNI01",
      name: "Áo Hoodie Form Rộng Unisex Nỉ Bông",
      categoryId: fashionCats["CAT-AOH"].id,
      unitOfMeasure: "Cái",
      description: "Áo hoodie nỉ bông cao cấp định lượng 380gsm, form oversize phong cách streetwear năng động.",
      images: [
        "https://images.unsplash.com/photo-1556905055-8f358a7a47b2?auto=format&fit=crop&w=800&q=80", // Đen
        "https://images.unsplash.com/photo-1578768079052-aa76e520028b?auto=format&fit=crop&w=800&q=80", // Xám
        "https://images.unsplash.com/photo-1509967419530-da38b4704bc6?auto=format&fit=crop&w=800&q=80", // Be
      ],
      variants: [
        { sku: "VNC-HOODIE-BLK-M", color: cDen, size: sM, cost: 180000, price: 340000, stock: 45 },
        { sku: "VNC-HOODIE-BLK-L", color: cDen, size: sL, cost: 180000, price: 340000, stock: 60 },
        { sku: "VNC-HOODIE-GRY-M", color: cXam, size: sM, cost: 180000, price: 340000, stock: 40 },
        { sku: "VNC-HOODIE-GRY-L", color: cXam, size: sL, cost: 180000, price: 340000, stock: 55 },
        { sku: "VNC-HOODIE-BEG-M", color: cBe, size: sM, cost: 180000, price: 340000, stock: 35 },
        { sku: "VNC-HOODIE-BEG-L", color: cBe, size: sL, cost: 180000, price: 340000, stock: 50 },
      ],
    },
    {
      code: "TMP-TSHIRT-COT01",
      name: "Áo Thun Cotton Compact Cổ Tròn Basic",
      categoryId: fashionCats["CAT-AOT"].id,
      unitOfMeasure: "Cái",
      description: "Chất liệu 100% cotton compact 2 chiều 250gsm thoáng mát, không xù lông và giữ form tốt sau nhiều lần giặt.",
      images: [
        "https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=800&q=80", // Trắng
        "https://images.unsplash.com/photo-1503342217505-b0a15ec3261c?auto=format&fit=crop&w=800&q=80", // Đen
        "https://images.unsplash.com/photo-1618354691373-d851c5c3a990?auto=format&fit=crop&w=800&q=80", // Xanh
      ],
      variants: [
        { sku: "VNC-TSHIRT-WHT-S", color: cTrang, size: sS, cost: 85000, price: 169000, stock: 80 },
        { sku: "VNC-TSHIRT-WHT-M", color: cTrang, size: sM, cost: 85000, price: 169000, stock: 120 },
        { sku: "VNC-TSHIRT-WHT-L", color: cTrang, size: sL, cost: 85000, price: 169000, stock: 95 },
        { sku: "VNC-TSHIRT-BLK-S", color: cDen, size: sS, cost: 85000, price: 169000, stock: 70 },
        { sku: "VNC-TSHIRT-BLK-M", color: cDen, size: sM, cost: 85000, price: 169000, stock: 110 },
        { sku: "VNC-TSHIRT-BLK-L", color: cDen, size: sL, cost: 85000, price: 169000, stock: 85 },
      ],
    },
    {
      code: "TMP-SHIRT-OXF01",
      name: "Áo Sơ Mi Nam Tay Dài Oxford Premium",
      categoryId: fashionCats["CAT-AOS"].id,
      unitOfMeasure: "Cái",
      description: "Dệt từ sợi bông Oxford tự nhiên bề mặt vải caro nhuyễn sang trọng, thích hợp đi làm và đi tiệc.",
      images: [
        "https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=800&q=80", // Trắng
        "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=800&q=80", // Xanh nhạt
      ],
      variants: [
        { sku: "VNC-SHIRT-WHT-M", color: cTrang, size: sM, cost: 155000, price: 295000, stock: 50 },
        { sku: "VNC-SHIRT-WHT-L", color: cTrang, size: sL, cost: 155000, price: 295000, stock: 65 },
        { sku: "VNC-SHIRT-WHT-XL", color: cTrang, size: sXL, cost: 155000, price: 295000, stock: 40 },
        { sku: "VNC-SHIRT-BLU-M", color: cXanhNavy, size: sM, cost: 155000, price: 295000, stock: 45 },
        { sku: "VNC-SHIRT-BLU-L", color: cXanhNavy, size: sL, cost: 155000, price: 295000, stock: 50 },
      ],
    },
    {
      code: "TMP-JEAN-SLIM01",
      name: "Quần Jean Nam Slimfit Co Giãn Cao Cấp",
      categoryId: fashionCats["CAT-QUA"].id,
      unitOfMeasure: "Cái",
      description: "Chất vải denim dệt thoi pha spandex co giãn nhẹ, form ôm vừa vặn tôn dáng thoải mái vận động.",
      images: [
        "https://images.unsplash.com/photo-1542272604-780c96856592?auto=format&fit=crop&w=800&q=80", // Xanh
        "https://images.unsplash.com/photo-1582552938357-32b906df40cb?auto=format&fit=crop&w=800&q=80", // Đen
      ],
      variants: [
        { sku: "VNC-JEAN-BLU-29", color: cXanhNavy, size: s29, cost: 195000, price: 385000, stock: 35 },
        { sku: "VNC-JEAN-BLU-30", color: cXanhNavy, size: s30, cost: 195000, price: 385000, stock: 50 },
        { sku: "VNC-JEAN-BLU-31", color: cXanhNavy, size: s31, cost: 195000, price: 385000, stock: 45 },
        { sku: "VNC-JEAN-BLK-29", color: cDen, size: s29, cost: 195000, price: 385000, stock: 30 },
        { sku: "VNC-JEAN-BLK-30", color: cDen, size: s30, cost: 195000, price: 385000, stock: 55 },
        { sku: "VNC-JEAN-BLK-31", color: cDen, size: s31, cost: 195000, price: 385000, stock: 40 },
      ],
    },
    {
      code: "TMP-BALO-LAP01",
      name: "Balo Laptop Unisex Chống Nước Đa Năng",
      categoryId: fashionCats["CAT-BAL"].id,
      unitOfMeasure: "Cái",
      description: "Vải Oxford trượt nước bền bỉ, ngăn chống sốc laptop 15.6 inch, thiết kế đệm lưng tổ ong thoáng khí.",
      images: [
        "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=80", // Đen
        "https://images.unsplash.com/photo-1622560480605-d83c853bc5c3?auto=format&fit=crop&w=800&q=80", // Xám
      ],
      variants: [
        { sku: "VNC-BALO-BLK-STD", color: cDen, size: sTieuChuan, cost: 175000, price: 349000, stock: 80 },
        { sku: "VNC-BALO-GRY-STD", color: cXam, size: sTieuChuan, cost: 175000, price: 349000, stock: 65 },
      ],
    },
    {
      code: "TMP-SNEAKER-RETRO",
      name: "Giày Sneaker Thể Thao Phong Cách Retro",
      categoryId: fashionCats["CAT-SNE"].id,
      unitOfMeasure: "Đôi",
      description: "Đế cao su đúc nguyên khối chống trơn trượt, lót mút êm ái thích hợp chạy bộ và mang hàng ngày.",
      images: [
        "https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=800&q=80", // Trắng
        "https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?auto=format&fit=crop&w=800&q=80", // Đen trắng
      ],
      variants: [
        { sku: "VNC-SNEAKER-WHT-40", color: cTrang, size: s40, cost: 260000, price: 520000, stock: 25 },
        { sku: "VNC-SNEAKER-WHT-41", color: cTrang, size: s41, cost: 260000, price: 520000, stock: 35 },
        { sku: "VNC-SNEAKER-WHT-42", color: cTrang, size: s42, cost: 260000, price: 520000, stock: 30 },
        { sku: "VNC-SNEAKER-BLK-40", color: cDen, size: s40, cost: 260000, price: 520000, stock: 20 },
        { sku: "VNC-SNEAKER-BLK-41", color: cDen, size: s41, cost: 260000, price: 520000, stock: 30 },
        { sku: "VNC-SNEAKER-BLK-42", color: cDen, size: s42, cost: 260000, price: 520000, stock: 25 },
      ],
    },
    {
      code: "TMP-SANDAL-STRAP",
      name: "Sandal Quai Ngang Thể Thao Êm Chân",
      categoryId: fashionCats["CAT-SAN"].id,
      unitOfMeasure: "Đôi",
      description: "Quai dù bền chắc chống thấm nước mau khô, quai dán tiện lợi điều chỉnh vừa vặn cổ chân.",
      images: [
        "https://images.unsplash.com/photo-1603808033192-082d6919d3e1?auto=format&fit=crop&w=800&q=80", // Đen
        "https://images.unsplash.com/photo-1562273138-f46be4ebdf33?auto=format&fit=crop&w=800&q=80", // Nâu
      ],
      variants: [
        { sku: "VNC-SANDAL-BLK-40", color: cDen, size: s40, cost: 120000, price: 235000, stock: 40 },
        { sku: "VNC-SANDAL-BLK-41", color: cDen, size: s41, cost: 120000, price: 235000, stock: 50 },
        { sku: "VNC-SANDAL-BRN-40", color: cNau, size: s40, cost: 120000, price: 235000, stock: 30 },
        { sku: "VNC-SANDAL-BRN-41", color: cNau, size: s41, cost: 120000, price: 235000, stock: 35 },
      ],
    },
    {
      code: "TMP-CAP-VINTAGE",
      name: "Nón Lưỡi Trai Classic Vintage Thêu Logo",
      categoryId: fashionCats["CAT-NON"].id,
      unitOfMeasure: "Cái",
      description: "Chất liệu kaki cotton wash mềm mại, form nón chuẩn đứng dáng, khóa đồng điều chỉnh kích thước phía sau.",
      images: [
        "https://images.unsplash.com/photo-1588850561407-ed78c282e89b?auto=format&fit=crop&w=800&q=80", // Be
        "https://images.unsplash.com/photo-1534215754734-18e55d13e346?auto=format&fit=crop&w=800&q=80", // Đen
      ],
      variants: [
        { sku: "VNC-CAP-BEG-FREE", color: cBe, size: sFree, cost: 65000, price: 135000, stock: 90 },
        { sku: "VNC-CAP-BLK-FREE", color: cDen, size: sFree, cost: 65000, price: 135000, stock: 110 },
      ],
    },
    {
      code: "TMP-BELT-LEATHER",
      name: "Thắt Lưng Da Bò Nam Khóa Kim Chống Gỉ",
      categoryId: fashionCats["CAT-TLG"].id,
      unitOfMeasure: "Sợi",
      description: "Da bò nguyên tấm dập vân hạt tự nhiên, bản 3.5cm chuẩn công sở, đầu khóa hợp kim mạ crom sáng bóng.",
      images: [
        "https://images.unsplash.com/photo-1624222247344-550fb60583dc?auto=format&fit=crop&w=800&q=80", // Nâu
        "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=80", // Đen
      ],
      variants: [
        { sku: "VNC-BELT-BRN-STD", color: cNau, size: sTieuChuan, cost: 115000, price: 245000, stock: 65 },
        { sku: "VNC-BELT-BLK-STD", color: cDen, size: sTieuChuan, cost: 115000, price: 245000, stock: 80 },
      ],
    },
    {
      code: "TMP-GLASS-UV400",
      name: "Kính Mát Thời Trang Phân Cực UV400",
      categoryId: fashionCats["CAT-KIN"].id,
      unitOfMeasure: "Cái",
      description: "Tròng kính phân cực Polaroid chống lóa và chống 100% tia UV400 độc hại, bảo vệ mắt tối đa khi lái xe.",
      images: [
        "https://images.unsplash.com/photo-1511499767150-a48a237f0083?auto=format&fit=crop&w=800&q=80", // Gọng đen
        "https://images.unsplash.com/photo-1572635196237-14b3f281503f?auto=format&fit=crop&w=800&q=80", // Gọng kim loại
      ],
      variants: [
        { sku: "VNC-GLASS-BLK-UV", color: cDen, size: sTieuChuan, cost: 125000, price: 280000, stock: 55 },
        { sku: "VNC-GLASS-GLD-UV", color: cGongVang, size: sTieuChuan, cost: 135000, price: 299000, stock: 45 },
      ],
    },
    {
      code: "TMP-SOCKS-COT03",
      name: "Set 3 Đôi Vớ Cổ Trung Cotton Kháng Khuẩn",
      categoryId: fashionCats["CAT-TAT"].id,
      unitOfMeasure: "Hộp",
      description: "Chất sợi cotton chải kỹ thấm hút mồ hôi chân tuyệt đối, công nghệ dệt nano bạc ngăn mùi hôi hiệu quả.",
      images: [
        "https://images.unsplash.com/photo-1586350977771-b3b0abd50c82?auto=format&fit=crop&w=800&q=80",
      ],
      variants: [
        { sku: "VNC-SOCKS-MIX-FREE", color: cMix, size: sFree, cost: 45000, price: 99000, stock: 150 },
      ],
    },
  ];

  const fashionVoucherItems = [];

  for (const fp of flagshipFashionProducts) {
    let t = await prisma.productTemplate.findFirst({
      where: { businessId: business1Id, code: fp.code },
    });

    const imageUrl = JSON.stringify(fp.images);

    if (!t) {
      t = await prisma.productTemplate.create({
        data: {
          businessId: business1Id,
          name: fp.name,
          code: fp.code,
          description: fp.description,
          categoryId: fp.categoryId,
          unitOfMeasure: fp.unitOfMeasure,
          hasLotTracking: false,
          imageUrl,
          isActive: true,
        },
      });
      console.log(`+ Đã tạo mẫu thời trang: ${fp.name}`);
    } else {
      await prisma.productTemplate.update({
        where: { id: t.id },
        data: { imageUrl, name: fp.name, description: fp.description, hasLotTracking: false, categoryId: fp.categoryId },
      });
    }

    for (const v of fp.variants) {
      let variant = await prisma.productVariant.findFirst({
        where: { businessId: business1Id, sku: v.sku },
      });

      if (!variant) {
        variant = await prisma.productVariant.create({
          data: {
            businessId: business1Id,
            templateId: t.id,
            sku: v.sku,
            barcode: generateEan13("8935001"),
            basePrice: v.price,
            costPrice: v.cost,
            safetyStockQty: 5,
            isActive: true,
          },
        });
      }

      // Link attribute values
      const links = [
        { attrId: v.color.attributeId, valId: v.color.id },
        { attrId: v.size.attributeId, valId: v.size.id },
      ];
      for (const l of links) {
        const exist = await prisma.variantAttributeValue.findFirst({
          where: { variantId: variant.id, attributeId: l.attrId },
        });
        if (!exist) {
          await prisma.variantAttributeValue.create({
            data: {
              variantId: variant.id,
              attributeId: l.attrId,
              attributeValueId: l.valId,
            },
          });
        }
      }

      // InventoryBalance without lot
      let balance = await prisma.inventoryBalance.findFirst({
        where: { businessId: business1Id, variantId: variant.id, lotId: null },
      });
      if (!balance) {
        await prisma.inventoryBalance.create({
          data: {
            businessId: business1Id,
            variantId: variant.id,
            lotId: null,
            quantityOnHand: v.stock,
          },
        });
      } else {
        await prisma.inventoryBalance.update({
          where: { id: balance.id },
          data: { quantityOnHand: v.stock },
        });
      }

      fashionVoucherItems.push({
        variantId: variant.id,
        quantity: v.stock,
        unitCost: v.cost,
      });
    }
  }

  // Create OpeningStockSheet for Vinaclothes
  const existingSheet1 = await prisma.openingStockSheet.findFirst({
    where: { businessId: business1Id, code: "OSTK-VNC-2026-001" },
  });
  if (!existingSheet1 && fashionVoucherItems.length > 0) {
    const sheet1 = await prisma.openingStockSheet.create({
      data: {
        businessId: business1Id,
        createdBy: user1.id,
        code: "OSTK-VNC-2026-001",
        note: "Phiếu kiểm kê nạp tồn kho ban đầu danh mục Thời trang & Phụ kiện Vinaclothes",
        status: "APPLIED",
        appliedAt: new Date(),
        openingStockItems: {
          create: fashionVoucherItems.map((it) => ({
            variantId: it.variantId,
            quantity: it.quantity,
            unitCost: it.unitCost,
          })),
        },
      },
    });
    console.log(`Đã tạo phiếu kiểm kê nạp tồn kho ${sheet1.code} cho Cửa hàng Thời trang Vinaclothes`);
  }

  console.log("\n=== HOÀN TẤT SEED DỮ LIỆU ĐỘC LẬP THÀNH CÔNG ===");
}

main()
  .catch((e) => {
    console.error("Lỗi khi seed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
