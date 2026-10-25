const { Client } = require('pg');
const crypto = require('crypto');

// Chay: DATABASE_URL="postgresql://..." node prisma/seed-demo.js
// Uu tien DIRECT_URL (port 5432) de tranh pgbouncer khi ghi du lieu lon.
const conn =
  process.env.DIRECT_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/postgres?sslmode=require';
const BUSINESS_ID = '34344b30-5ac6-4375-9d84-52c993d25ed7';

const IMG = (id, w = 800) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&h=520&q=80`;

const leaves = [
  {
    key: 'POLO', name: 'Áo Polo', parent: 'Thời trang', unit: 'cái', cost: [150000, 260000], price: [320000, 620000],
    images: ['1586790170083-2f9ceadc732d', '1551232864-3f0890e580d9', '1562157873-818bc0726f68', '1598033129183-c4f50c736f10', '1610652492500-ded49ceeb378', '1618354691373-d851c5c3a990'],
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    desc: 'Chất liệu cotton Pima cao cấp, co giãn 4 chiều thoáng mát, thấm hút mồ hôi tốt, form chuẩn công sở.',
    names: ['Áo Polo Pima Cotton Cao Cấp', 'Áo Polo Cổ Bẻ Basic', 'Áo Polo Thể Thao Dry-Fit', 'Áo Polo Oxford Premium', 'Áo Polo Pique Classic', 'Áo Polo Dệt Kim Ngang', 'Áo Polo Dài Tay Công Sở', 'Áo Polo Cotton Compact', 'Áo Polo Pima Logo Thêu', 'Áo Polo Sọc Ngang Retro', 'Áo Polo Nữ Form Rộng', 'Áo Polo Nam Tay Dài', 'Áo Polo Coolmax Thoáng Khí', 'Áo Polo Bamboo Mềm Mại', 'Áo Polo Kẻ Sọc Cổ V', 'Áo Polo Trơn Basic Form Suông']
  },
  {
    key: 'TSHT', name: 'Áo Thun', parent: 'Thời trang', unit: 'cái', cost: [90000, 160000], price: [190000, 390000],
    images: ['1521572163474-6864f9cf17ab', '1523381210434-271e8be1f52b', '1503341504253-dff4815485f1', '1622445275463-afa2ab738c34', '1603252109303-2751441dd157', '1525507119028-ed4c629a60a3'],
    sizes: ['S', 'M', 'L', 'XL'],
    desc: 'Cotton compact 100% định lượng 220gsm, bề mặt mịn, đứng form, không xù lông sau nhiều lần giặt.',
    names: ['Áo Thun Cotton Compact', 'Áo Thun Oversize Form Rộng', 'Áo Thun Nam Cổ Tròn Basic', 'Áo Thun Nữ Croptop', 'Áo Thun Polo Thể Thao', 'Áo Thun In Graphic Local Brand', 'Áo Thun Modal Mát Lạnh', 'Áo Thun Tay Lỡ Unisex', 'Áo Thun Ribbed Ôm Body', 'Áo Thun Heavyweight 250gsm', 'Áo Thun Phối Bo Cổ', 'Áo Thun Sọc Ngang Classic', 'Áo Thun Tank Top Cotton', 'Áo Thun Dài Tay Thu Đông', 'Áo Thun Thể Thao Nhanh Khô', 'Áo Thun Trơn Đa Màu']
  },
  {
    key: 'SOMI', name: 'Áo Sơ Mi', parent: 'Thời trang', unit: 'cái', cost: [180000, 320000], price: [390000, 720000],
    images: ['1594633312681-425c7b97ccd1', '1598033129183-c4f50c736f10', '1551232864-3f0890e580d9', '1562157873-818bc0726f68', '1441984904996-e0b6ba687e04'],
    sizes: ['S', 'M', 'L', 'XL'],
    desc: 'Vải lụa pha cotton mềm mại, đường may tỉ mỉ, phù hợp môi trường công sở và dạo phố.',
    names: ['Áo Sơ Mi Lụa Cao Cấp', 'Áo Sơ Mi Trắng Công Sở', 'Áo Sơ Mi Oxford Dài Tay', 'Áo Sơ Mi Kẻ Sọc Classic', 'Áo Sơ Mi Linen Mùa Hè', 'Áo Sơ Mi Nữ Tay Bồng', 'Áo Sơ Mi Denim Nhẹ', 'Áo Sơ Mi Họa Tiết Hoa', 'Áo Sơ Mi Cổ Đức Basic', 'Áo Sơ Mi Croptop Nữ', 'Áo Sơ Mi Satin Mềm Mại', 'Áo Sơ Mi Dù Chống Nhăn']
  },
  {
    key: 'JEAN', name: 'Quần Jean', parent: 'Thời trang', unit: 'cái', cost: [200000, 340000], price: [420000, 790000],
    images: ['1541099649105-f69ad21f3246', '1489987707025-afc232f7ea0f', '1434389677669-e08b4cac3105', '1483985988355-763728e1935b'],
    sizes: ['28', '29', '30', '31', '32'],
    desc: 'Denim co giãn nhẹ, giữ phom tốt, màu nhuộm bền đẹp, phù hợp nhiều dáng người.',
    names: ['Quần Jean Slim Fit', 'Quần Jean Straight Leg', 'Quần Jean Skinny Co Giãn', 'Quần Jean Ống Rộng Baggy', 'Quần Jean Nam Xanh Đậm', 'Quần Jean Nữ Lưng Cao', 'Quần Jean Rách Gối', 'Quần Jean Bootcut', 'Quần Jean Denim Nhẹ Mùa Hè', 'Quần Jean Cạp Chun Thoải Mái', 'Quần Jean Ống Suông Vintage', 'Quần Jean Short Ngắn']
  },
  {
    key: 'DRS', name: 'Đầm & Váy', parent: 'Thời trang', unit: 'chiếc', cost: [190000, 330000], price: [450000, 850000],
    images: ['1595777457583-95e059d581b8', '1572804013309-59a88b7e92f1', '1626497764746-6dc36546b388', '1490481651871-ab68de25d43d', '1445205170230-053b83016050'],
    sizes: ['S', 'M', 'L', 'XL'],
    desc: 'Thiết kế dáng xòe tôn dáng, chất liệu voan tơ mềm nhẹ, lót trong kỹ càng, tôn da người mặc.',
    names: ['Đầm Midi Hoa Nhí Dáng Xòe', 'Đầm Maxi Voan Bay Bổng', 'Đầm Công Sở Chữ A', 'Đầm Body Đen Ôm Sát', 'Đầm Satin Dự Tiệc', 'Đầm Hai Dây Lụa', 'Đầm Trễ Vai Nữ Tính', 'Đầm Yếm Denim', 'Đầm Xếp Ly Cổ V', 'Đầm Dài Tay Cổ Đức', 'Váy Tennis Xếp Ly', 'Váy Xòe Họa Tiết', 'Váy Chữ A Lưng Cao', 'Váy Liền Thân Công Sở']
  },
  {
    key: 'SKIN', name: 'Chăm sóc da', parent: 'Mỹ phẩm', unit: 'chai', cost: [80000, 240000], price: [195000, 690000],
    images: ['1620916566398-39f1143ab7be', '1556228578-8c89e6adf883', '1608248543803-ba4f8c70ae0b', '1598440947619-2c35fc9aa908', '1556228720-195a672e8a03', '1611930022073-b7a4ba5fcccd', '1601049541289-9b1b7bbbfe19', '1612817288484-6f916006741a', '1617897903246-719242758050', '1571781926291-c477ebfd024b', '1620916297397-a4a5402a3c6c'],
    sizes: ['30ml', '50ml', '100ml'],
    desc: 'Công thức dịu nhẹ không cồn, cấp ẩm sâu, phục hồi hàng rào bảo vệ da, an toàn cho da nhạy cảm.',
    names: ['Serum Phục Hồi B5 Hyaluronic', 'Sữa Rửa Mặt Tạo Bọt Cica Dịu Nhẹ', 'Nước Hoa Hồng Cấp Ẩm', 'Kem Dưỡng Trắng Da Ban Đêm', 'Tinh Chất Vitamin C 15%', 'Gel Dưỡng Ẩm Aloe Vera', 'Kem Dưỡng Phục Hồi Da Barrie', 'Mặt Nạ Ngủ Hydrogel', 'Dung Dịch Tẩy Da Chết BHA', 'Serum Niacinamide 10%', 'Kem Mắt Giảm Thâm Quầng', 'Sữa Rửa Mặt Sạch Sâu', 'Toner Cân Bằng pH', 'Kem Dưỡng Chống Lão Hóa', 'Tinh Chất Retinol 0.5%', 'Xịt Khoáng Cấp Ẩm', 'Gel Rửa Mặt Tràm Trà']
  },
  {
    key: 'SUN', name: 'Chống nắng', parent: 'Mỹ phẩm', unit: 'tuýp', cost: [120000, 220000], price: [290000, 520000],
    images: ['1575428652377-a2d80e2277fc', '1556228720-195a672e8a03', '1608248543803-ba4f8c70ae0b', '1611930022073-b7a4ba5fcccd'],
    sizes: ['30ml', '50ml', '90ml'],
    desc: 'Bảo vệ phổ rộng UVA/UVB, kết cấu mỏng nhẹ thấm nhanh, không bết dính, phù hợp khí hậu nóng ẩm.',
    names: ['Kem Chống Nắng Phổ Rộng SPF50+', 'Sữa Chống Nắng Nâng Tone', 'Kem Chống Nắng Kiềm Dầu', 'Xịt Chống Nắng Toàn Thân', 'Kem Chống Nắng Vật Lý', 'Sữa Chống Nắng Dạng Gel', 'Kem Chống Nắng Trẻ Em', 'Kem Chống Nắng Đi Biển', 'Chống Nắng Dạng Thỏi', 'Kem Chống Nắng Dưỡng Ẩm']
  },
  {
    key: 'MKUP', name: 'Trang điểm', parent: 'Mỹ phẩm', unit: 'hộp', cost: [110000, 260000], price: [280000, 620000],
    images: ['1596462502278-27bfdc403348', '1598440947619-2c35fc9aa908', '1512436991641-6745cdb1723f', '1512496015851-a90fb38ba796', '1522335789203-aabd1fc54bc9'],
    sizes: ['01', '02', '03', '04'],
    desc: 'Kết cấu mịn lì, bám màu lâu trôi, che phủ tự nhiên, phù hợp mọi tông da Á Đông.',
    names: ['Phấn Nền Kiềm Dầu 24H', 'Cushion Che Phủ Cao', 'Son Kem Lì Mịn Môi', 'Mascara Cong Mi 4D', 'Phấn Má Hồng Dạng Kem', 'Bút Kẻ Mắt Nước', 'Kem Che Khuyết Điểm', 'Son Thỏi Dưỡng Ẩm']
  },
  {
    key: 'PERF', name: 'Nước hoa', parent: 'Mỹ phẩm', unit: 'chai', cost: [250000, 520000], price: [590000, 1290000],
    images: ['1585386959984-a4155224a1ad', '1543163521-1bf539c55dd2', '1594035910387-fea47794261f', '1541643600914-78b084683601'],
    sizes: ['10ml', '30ml', '50ml', '100ml'],
    desc: 'Nồng độ lưu hương 8-12 giờ, thiết kế chai sang trọng, phù hợp làm quà tặng cao cấp.',
    names: ['Nước Hoa Nữ Hương Hoa Cỏ', 'Nước Hoa Nam Hương Gỗ', 'Nước Hoa Unisex Hương Cam', 'Nước Hoa Mini 10ml', 'Nước Hoa Hồng Cổ Điển', 'Nước Hoa Quýt Tươi Mát', 'Nước Hoa Xạ Hương Ấm', 'Nước Hoa Biển Khơi']
  },
  {
    key: 'SNKR', name: 'Sneaker', parent: 'Giày dép', unit: 'đôi', cost: [280000, 520000], price: [590000, 1290000],
    images: ['1542291026-7eec264c27ff', '1600269452121-4f2416e55c28', '1549298916-b41d501d3772', '1560769629-975ec94e6a86', '1595341888016-a392ef81b7de', '1552346154-21d32810aba3', '1525966222134-fcfa99b8ae77', '1556906781-9a412961c28c', '1600185365483-26d7a4cc7519', '1460353581641-37baddab0fa2'],
    sizes: ['38', '39', '40', '41', '42', '43'],
    desc: 'Da bò nappa mềm mại, đế cao su đúc nguyên khối, đệm lót êm ái cho mọi hoạt động.',
    names: ['Giày Sneaker Retro Da Bò Nappa', 'Giày Sneaker Trắng Basic', 'Giày Sneaker Chunky Đế Dày', 'Giày Sneaker Running Siêu Nhẹ', 'Giày Sneaker Canvas Cổ Thấp', 'Giày Sneaker Da Lộn Vintage', 'Giày Sneaker Nam Nữ Unisex', 'Giày Sneaker Đế Air Cushion', 'Giày Sneaker Thể Thao Năng Động', 'Giày Sneaker Cổ Cao Basketball', 'Giày Sneaker Minimalist Trơn', 'Giày Sneaker Phối Lưới Thoáng', 'Giày Sneaker Đế Bánh Mì', 'Giày Sneaker Retro Hàn Quốc', 'Giày Sneaker Da Trơn Công Sở', 'Giày Sneaker Chunky Trắng Kem']
  },
  {
    key: 'SDAL', name: 'Sandal', parent: 'Giày dép', unit: 'đôi', cost: [150000, 280000], price: [350000, 690000],
    images: ['1512436991641-6745cdb1723f', '1591047139829-d91aecb6caea', '1556906781-9a412961c28c', '1460353581641-37baddab0fa2'],
    sizes: ['36', '37', '38', '39', '40'],
    desc: 'Quai da mềm ôm chân, đế chống trượt, thiết kế thanh lịch dễ phối đồ.',
    names: ['Dép Sandal Quai Ngang', 'Sandal Cao Gót Quai Mảnh', 'Sandal Bệt Da Bò', 'Sandal Đế Bánh Mì Nữ', 'Dép Quai Hậu Thể Thao', 'Sandal Quai Chéo Đan', 'Sandal Nữ Gót Vuông']
  },
  {
    key: 'BAG', name: 'Túi xách', parent: 'Phụ kiện', unit: 'chiếc', cost: [220000, 450000], price: [490000, 1150000],
    images: ['1595950653106-6c9ebd614d3a', '1584917865442-de89df76afd3', '1553062407-98eeb64c6a62', '1548036328-c9fa89d128fa', '1590874103328-eac38a683ce7', '1566150905458-1bf1fc113f0d', '1594223274512-ad4803739b7c'],
    sizes: ['Mini', 'M', 'L'],
    desc: 'Da PU cao cấp chống nước, khóa kim loại xi mạ, nhiều ngăn tiện dụng khi ra ngoài.',
    names: ['Túi Xách Da Mini', 'Túi Tote Vải Canvas', 'Túi Đeo Chéo Da PU', 'Túi Xách Công Sở Cỡ Lớn', 'Túi Clutch Dự Tiệc']
  }
];

const uncategorized = [
  { name: 'Bộ Sản Phẩm Dùng Thử Mùa Lễ Hội', unit: 'bộ', code: 'TMP-MISC-SET01', image: '1612817288484-6f916006741a' },
  { name: 'Combo Quà Tặng Chăm Sóc Da', unit: 'bộ', code: 'TMP-MISC-GIFT01', image: '1601049541289-9b1b7bbbfe19' },
  { name: 'Áo Khoác Gió Chống Nắng', unit: 'cái', code: 'TMP-MISC-JKT01', image: '1603252109303-2751441dd157' },
  { name: 'Khăn Choàng Lụa Họa Tiết', unit: 'chiếc', code: 'TMP-MISC-SCF01', image: '1601924994987-69e26d50dc26' },
  { name: 'Bình Giữ Nhiệt Inox 500ml', unit: 'cái', code: 'TMP-MISC-BTL01', image: '1523362628745-0c100150b504' },
  { name: 'Đèn Ngủ Cảm Ứng Mini', unit: 'cái', code: 'TMP-MISC-LMP01', image: '1507473885765-e6ed057f782c' },
  { name: 'Bộ Dụng Cụ Trang Điểm Cơ Bản', unit: 'bộ', code: 'TMP-MISC-KIT01', image: '1512496015851-a90fb38ba796' }
];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261024);
const uid = () => crypto.randomUUID();

const removeDiacritics = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
const styleToken = (name) => {
  const words = removeDiacritics(name).toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const skip = new Set(['AO', 'QUAN', 'GIAY', 'DEP', 'TUI', 'NAM', 'NU', 'VAY', 'DAM', 'BANG', 'TRON', 'CAO', 'CAP', 'POLO', 'THUN', 'SOMI', 'JEAN', 'SKIN', 'SUN', 'MKUP', 'PERF', 'SNKR', 'SDAL', 'BAG', 'CHONG', 'KEM', 'NUOC', 'GIAY']);
  const w = words.find((x) => !skip.has(x) && x.length > 2) || words[0] || 'SP';
  return w.slice(0, 4);
};

function ean13(seedNum) {
  const base = '893' + String(seedNum).padStart(9, '0').slice(-9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  return base + ((10 - (sum % 10)) % 10);
}

function bulkInsert(client, table, columns, rows, cast = '') {
  if (!rows.length) return Promise.resolve();
  const chunkSize = 200;
  const jobs = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const params = [];
    chunk.forEach((row) => {
      values.push('(' + row.map((_, ci) => `$${params.length + ci + 1}` + cast).join(',') + ')');
      params.push(...row);
    });
    jobs.push(client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')}`, params));
  }
  return Promise.all(jobs);
}

(async () => {
  const c = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('BEGIN');

  await c.query('DELETE FROM variant_attribute_values WHERE variant_id IN (SELECT id FROM product_variants WHERE business_id=$1)', [BUSINESS_ID]);
  await c.query('DELETE FROM inventory_balances WHERE business_id=$1', [BUSINESS_ID]);
  await c.query('DELETE FROM product_variants WHERE business_id=$1', [BUSINESS_ID]);
  await c.query('DELETE FROM product_templates WHERE business_id=$1', [BUSINESS_ID]);
  await c.query('DELETE FROM categories WHERE business_id=$1', [BUSINESS_ID]);

  const parentNames = [...new Set(leaves.map((l) => l.parent))];
  const parentIds = {};
  const categoryRows = [];
  for (const p of parentNames) {
    const id = uid();
    parentIds[p] = id;
    categoryRows.push([id, BUSINESS_ID, p, null]);
  }
  const leafIds = {};
  for (const l of leaves) {
    const id = uid();
    leafIds[l.key] = id;
    categoryRows.push([id, BUSINESS_ID, l.name, parentIds[l.parent]]);
  }
  await bulkInsert(c, 'categories', ['id', 'business_id', 'name', 'parent_id'], categoryRows, );

  const descSuffixes = [
    'Hàng chính hãng, bảo hành 12 tháng.',
    'Được khách hàng lựa chọn nhiều nhất mùa này.',
    'Phù hợp sử dụng hằng ngày và làm quà tặng.',
    'Đóng gói cẩn thận, giao hàng toàn quốc.',
  ];
  const products = [];
  for (const l of leaves) {
    l.names.forEach((name, i) => {
      products.push({
        categoryId: leafIds[l.key],
        leaf: l,
        name,
        code: `TMP-${l.key}-${styleToken(name)}${String(i + 1).padStart(2, '0')}`,
        image: IMG(l.images[i % l.images.length]),
        desc: `${l.desc} ${descSuffixes[i % descSuffixes.length]}`,
        unit: l.unit,
      });
    });
  }
  for (const u of uncategorized) {
    products.push({
      categoryId: null,
      leaf: null,
      name: u.name,
      code: u.code,
      image: u.image ? IMG(u.image) : IMG('1522335789203-aabd1fc54bc9'),
      desc: 'Sản phẩm đang chờ chuẩn hóa danh mục trước khi đưa lên kệ bán hàng.',
      unit: u.unit,
    });
  }

  const templateRows = [];
  const variantRows = [];
  const balanceRows = [];
  let barcodeSeq = 100000;

  products.forEach((p, idx) => {
    const templateId = uid();
    p.id = templateId;
    const lotTracking = p.leaf ? (p.leaf.key === 'SKIN' || p.leaf.key === 'SUN') : false;
    templateRows.push([templateId, BUSINESS_ID, p.name, p.categoryId, p.unit, p.desc, lotTracking, true, p.code, p.image]);

    let count = 2 + ((idx * 3) % 4);
    if (idx < 8) count += 1;

    const sizes = p.leaf ? p.leaf.sizes : ['Tiêu chuẩn'];
    const priceRange = p.leaf ? p.leaf.price : [150000, 450000];
    const costRange = p.leaf ? p.leaf.cost : [80000, 250000];

    for (let v = 0; v < count; v++) {
      const size = sizes[v % sizes.length];
      const jitter = 0.9 + rand() * 0.2;
      const price = Math.round(((priceRange[0] + rand() * (priceRange[1] - priceRange[0])) * jitter) / 1000) * 1000;
      const cost = Math.round(((costRange[0] + rand() * (costRange[1] - costRange[0])) * jitter) / 1000) * 1000;
      const suffix = size.replace(/[^A-Za-z0-9]/g, '').toUpperCase() + (v >= sizes.length ? String(Math.floor(v / sizes.length)) : '');
      const sku = `${p.code}-${suffix}`;
      const variantId = uid();
      variantRows.push([variantId, BUSINESS_ID, templateId, sku, ean13(barcodeSeq++), price, cost, true]);
      balanceRows.push([uid(), BUSINESS_ID, variantId, null, 4 + Math.floor(rand() * 38), 0]);
    }
  });

  await bulkInsert(c, 'product_templates',
    ['id', 'business_id', 'name', 'category_id', 'unit_of_measure', 'description', 'has_lot_tracking', 'is_active', 'code', 'image_url'],
    templateRows, );

  await bulkInsert(c, 'product_variants',
    ['id', 'business_id', 'template_id', 'sku', 'barcode', 'base_price', 'cost_price', 'is_active'],
    variantRows, );

  await bulkInsert(c, 'inventory_balances',
    ['id', 'business_id', 'variant_id', 'lot_id', 'quantity_on_hand', 'damaged_quantity'],
    balanceRows, );

  await c.query('COMMIT');

  const t = await c.query('SELECT count(*)::int n FROM product_templates WHERE business_id=$1', [BUSINESS_ID]);
  const v = await c.query('SELECT count(*)::int n FROM product_variants WHERE business_id=$1', [BUSINESS_ID]);
  const cat = await c.query('SELECT count(*)::int n FROM categories WHERE business_id=$1', [BUSINESS_ID]);
  const miss = await c.query('SELECT count(*)::int n FROM product_templates WHERE business_id=$1 AND category_id IS NULL', [BUSINESS_ID]);
  const val = await c.query(
    `SELECT COALESCE(sum(pv.cost_price * ib.quantity_on_hand),0)::bigint v,
            COALESCE(sum(pv.base_price * ib.quantity_on_hand),0)::bigint rev
     FROM product_variants pv JOIN inventory_balances ib ON ib.variant_id = pv.id WHERE pv.business_id=$1`,
    [BUSINESS_ID]
  );
  console.log('templates', t.rows[0].n, 'variants', v.rows[0].n, 'categories', cat.rows[0].n, 'missingCat', miss.rows[0].n);
  console.log('stockValue', val.rows[0].v, 'retailValue', val.rows[0].rev);
  await c.end();
})().catch((e) => { console.error('ERR:' + e.message); process.exit(1); });
