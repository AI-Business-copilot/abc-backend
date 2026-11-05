import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import app from "../app";
import { prisma } from "../shared/infrastructure/database/prisma.client";

describe("Workflow WF-03 (F05 Customer Returns & F06 Vendor Returns)", () => {
  let server: http.Server;
  let baseUrl: string;

  // Use existing business with real OWNER and STAFF users
  const businessId = "34344b30-5ac6-4375-9d84-52c993d25ed7"; // Shop thời trang H&X
  const ownerAuthId = "cec54aa7-d9ae-4627-9629-b4ba8ccd7835"; // huongtuti511@gmail.com (OWNER)
  const staffAuthId = "1144ffe2-63a8-403e-8570-ef19d6b1fade"; // tuanmqse170562@fpt.edu.vn (STAFF)
  let ownerUserId: string;

  let shiftId: string;
  let supplierId: string;
  let templateId: string;
  let variantAId: string;
  let variantBId: string;
  let variantCId: string;
  let variantLockedId: string;
  let completedOrderCode: string;
  let completedOrderId: string;
  let orderItemId: string;

  const orderUnitPrice = 100000;
  const orderUnitCost = 60000;
  const vendorReturnUnitPrice = 50000;
  const initialSupplierDebt = 5000000;

  before(async () => {
    // 1. Start test HTTP server on ephemeral port
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address() as any;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 2. Fetch owner user
    const ownerUser = await prisma.user.findUniqueOrThrow({
      where: { authUserId: ownerAuthId },
    });
    ownerUserId = ownerUser.id;

    // 3. Create cash shift
    const shift = await prisma.cashShift.create({
      data: {
        businessId,
        userId: ownerUserId,
        openingCash: 1000000,
        status: "OPEN",
      },
    });
    shiftId = shift.id;

    // 4. Create supplier
    const randomSuffix = Math.floor(100000 + Math.random() * 900000);
    const supplier = await prisma.supplier.create({
      data: {
        businessId,
        name: `NCC May Mặc ${randomSuffix}`,
        phone: `0912${randomSuffix}`,
        debtAmount: initialSupplierDebt,
      },
    });
    supplierId = supplier.id;

    // 5. Create product template
    const template = await prisma.productTemplate.create({
      data: {
        businessId,
        name: `Áo polo cao cấp ${randomSuffix}`,
        unitOfMeasure: "Cái",
      },
    });
    templateId = template.id;

    // 6. Create product variants
    // Variant A: Dùng cho Customer Return F05
    const variantA = await prisma.productVariant.create({
      data: {
        businessId,
        templateId: template.id,
        sku: `SKU-A-${randomSuffix}`,
        basePrice: orderUnitPrice,
        costPrice: orderUnitCost,
        isLockedForAudit: false,
      },
    });
    variantAId = variantA.id;

    // Variant B: Dùng cho Vendor Return Happy Path F06
    const variantB = await prisma.productVariant.create({
      data: {
        businessId,
        templateId: template.id,
        sku: `SKU-B-${randomSuffix}`,
        basePrice: 80000,
        costPrice: vendorReturnUnitPrice,
        isLockedForAudit: false,
      },
    });
    variantBId = variantB.id;

    // Variant C: Dùng cho Vendor Return Exceed Stock F06
    const variantC = await prisma.productVariant.create({
      data: {
        businessId,
        templateId: template.id,
        sku: `SKU-C-${randomSuffix}`,
        basePrice: 80000,
        costPrice: vendorReturnUnitPrice,
        isLockedForAudit: false,
      },
    });
    variantCId = variantC.id;

    // Variant Locked: Dùng để test Lock Check (409)
    const variantLocked = await prisma.productVariant.create({
      data: {
        businessId,
        templateId: template.id,
        sku: `SKU-LOCKED-${randomSuffix}`,
        basePrice: 80000,
        costPrice: vendorReturnUnitPrice,
        isLockedForAudit: true,
      },
    });
    variantLockedId = variantLocked.id;

    // 7. Khởi tạo Inventory Balances
    // Variant A: bắt đầu với on_hand = 10, damaged = 0
    await prisma.inventoryBalance.create({
      data: {
        businessId,
        variantId: variantAId,
        quantityOnHand: 10,
        damagedQuantity: 0,
      },
    });

    // Variant B: bắt đầu với on_hand = 10
    await prisma.inventoryBalance.create({
      data: {
        businessId,
        variantId: variantBId,
        quantityOnHand: 10,
        damagedQuantity: 0,
      },
    });

    // Variant C: bắt đầu với on_hand = 5 (để test cố tình trả 10 cái -> bị từ chối)
    await prisma.inventoryBalance.create({
      data: {
        businessId,
        variantId: variantCId,
        quantityOnHand: 5,
        damagedQuantity: 0,
      },
    });

    // 8. Tạo đơn hàng gốc COMPLETED cho F05 (mua 2 cái variantA)
    completedOrderCode = `ORD-${randomSuffix}`;
    const order = await prisma.order.create({
      data: {
        businessId,
        shiftId,
        orderCode: completedOrderCode,
        cashierId: ownerUserId,
        totalGrossAmount: 2 * orderUnitPrice,
        discountAmount: 0,
        totalNetAmount: 2 * orderUnitPrice,
        totalCogsAmount: 2 * orderUnitCost,
        grossProfit: 2 * (orderUnitPrice - orderUnitCost),
        status: "COMPLETED",
        orderItems: {
          create: [
            {
              variantId: variantAId,
              quantity: 2,
              unitPrice: orderUnitPrice,
              unitCost: orderUnitCost,
              discountAmount: 0,
              subtotal: 2 * orderUnitPrice,
            },
          ],
        },
      },
      include: { orderItems: true },
    });
    completedOrderId = order.id;
    orderItemId = order.orderItems[0].id;
  });

  after(async () => {
    // Dọn dẹp dữ liệu test đã tạo
    try {
      await prisma.cashTransaction.deleteMany({
        where: { businessId, shiftId },
      });
      await prisma.inventoryLedger.deleteMany({
        where: {
          businessId,
          variantId: { in: [variantAId, variantBId, variantCId, variantLockedId] },
        },
      });
      await prisma.customerReturnItem.deleteMany({
        where: { variantId: { in: [variantAId, variantLockedId] } },
      });
      await prisma.customerReturn.deleteMany({
        where: { businessId, originalOrderId: completedOrderId },
      });
      await prisma.vendorReturnItem.deleteMany({
        where: { variantId: { in: [variantAId, variantBId, variantCId, variantLockedId] } },
      });
      await prisma.vendorReturn.deleteMany({
        where: { businessId, supplierId },
      });
      await prisma.orderItem.deleteMany({
        where: { orderId: completedOrderId },
      });
      await prisma.order.deleteMany({
        where: { id: completedOrderId },
      });
      await prisma.inventoryBalance.deleteMany({
        where: {
          businessId,
          variantId: { in: [variantAId, variantBId, variantCId, variantLockedId] },
        },
      });
      await prisma.productVariant.deleteMany({
        where: {
          businessId,
          id: { in: [variantAId, variantBId, variantCId, variantLockedId] },
        },
      });
      if (templateId) {
        await prisma.productTemplate.deleteMany({
          where: { businessId, id: templateId },
        });
      }
      if (supplierId) {
        await prisma.supplier.deleteMany({
          where: { businessId, id: supplierId },
        });
      }
      if (shiftId) {
        await prisma.cashShift.deleteMany({
          where: { businessId, id: shiftId },
        });
      }
    } catch (e) {
      console.warn("Cleanup warning:", e);
    }

    if (server) {
      server.close();
    }
    await prisma.$disconnect();
  });

  // Helper hàm gọi API qua HTTP
  const apiCall = async (
    path: string,
    options: {
      method?: string;
      authId?: string;
      role?: string;
      body?: any;
    } = {},
  ) => {
    const authId = options.authId ?? ownerAuthId;
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "x-test-auth-id": authId,
        ...(options.role ? { "x-test-role": options.role } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, body: data };
  };

  // --- KIỂM TRA ROUTE LOOKUP ---
  it("GET /api/customer-returns/lookup/:orderCode returns original items and returnable_qty", async () => {
    const res = await apiCall(`/api/customer-returns/lookup/${completedOrderCode}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.order.orderCode, completedOrderCode);
    assert.strictEqual(res.body.items.length, 1);
    assert.strictEqual(res.body.items[0].quantity, 2);
    assert.strictEqual(res.body.items[0].previouslyReturnedQty, 0);
    assert.strictEqual(res.body.items[0].returnableQty, 2);
  });

  // --- 6 TEST CASES BẮT BUỘC (TC-F05-01 -> TC-F06-03) ---

  // TC-F05-01 (Happy Path - Restockable)
  it("TC-F05-01: Happy Path - Restockable: Return 1 item -> on_hand +1, damaged unchanged, ledger & cash recorded", async () => {
    // 1. Khách trả 1 sản phẩm nguyên vẹn RESTOCKABLE
    const res = await apiCall("/api/customer-returns", {
      method: "POST",
      body: {
        orderCode: completedOrderCode,
        refundMethod: "CASH",
        items: [
          {
            orderItemId,
            variantId: variantAId,
            returnQty: 1,
            itemCondition: "RESTOCKABLE",
            returnReason: "Khách đổi ý muốn lấy size khác",
          },
        ],
      },
    });

    assert.strictEqual(res.status, 201, `Failed with: ${JSON.stringify(res.body)}`);

    // 2. Kiểm tra tồn kho inventory_balances: quantity_on_hand tăng 1 (từ 10 lên 11), damaged_quantity giữ nguyên (0)
    const balance = await prisma.inventoryBalance.findFirst({
      where: { businessId, variantId: variantAId, lotItemId: null },
    });
    assert.ok(balance, "InventoryBalance must exist");
    assert.strictEqual(balance.quantityOnHand, 11, "quantity_on_hand must increase from 10 to 11");
    assert.strictEqual(balance.damagedQuantity, 0, "damaged_quantity must remain 0");

    // 3. Kiểm tra inventory_ledger: transaction_type = 'CUSTOMER_RETURN', quantity_changed = +1, unit_cost = orderItem.unit_cost
    const ledger = await prisma.inventoryLedger.findFirst({
      where: {
        businessId,
        variantId: variantAId,
        transactionType: "CUSTOMER_RETURN",
        referenceDocId: res.body.id,
      },
    });
    assert.ok(ledger, "InventoryLedger must be recorded");
    assert.strictEqual(ledger.quantityChanged, 1, "quantity_changed must be +1");
    assert.strictEqual(Number(ledger.unitCost), orderUnitCost, `unit_cost must be ${orderUnitCost}`);
    assert.strictEqual(Number(ledger.totalCostValue), orderUnitCost, `total_cost_value must be ${orderUnitCost}`);

    // 4. Kiểm tra cash_transactions: transaction_type = 'OUT', category = 'CUSTOMER_REFUND'
    const cash = await prisma.cashTransaction.findFirst({
      where: {
        businessId,
        refDocId: res.body.id,
        transactionType: "OUT",
        category: "CUSTOMER_REFUND",
      },
    });
    assert.ok(cash, "CashTransaction must be recorded for cash refund");
    assert.strictEqual(Number(cash.amount), orderUnitPrice, `Refund amount must equal unit price ${orderUnitPrice}`);
  });

  // TC-F05-02 (Business Rule - Damaged Quarantine)
  it("TC-F05-02: Business Rule - Damaged Quarantine: Return 1 item -> on_hand unchanged, damaged +1", async () => {
    // 1. Khách trả 1 sản phẩm hỏng DAMAGED_QUARANTINE
    const res = await apiCall("/api/customer-returns", {
      method: "POST",
      body: {
        orderCode: completedOrderCode,
        refundMethod: "CASH",
        items: [
          {
            orderItemId,
            variantId: variantAId,
            returnQty: 1,
            itemCondition: "DAMAGED_QUARANTINE",
            returnReason: "Hàng bị lỗi vải",
          },
        ],
      },
    });

    assert.strictEqual(res.status, 201, `Failed with: ${JSON.stringify(res.body)}`);

    // 2. Kiểm tra tồn kho inventory_balances
    const balance = await prisma.inventoryBalance.findFirst({
      where: { businessId, variantId: variantAId, lotItemId: null },
    });
    assert.ok(balance, "InventoryBalance must exist");
    // TUYỆT ĐỐI KHÔNG cộng vào quantityOnHand (vẫn là 11 từ TC-F05-01)
    assert.strictEqual(balance.quantityOnHand, 11, "quantity_on_hand must remain 11");
    // damaged_quantity tăng 1 (từ 0 lên 1)
    assert.strictEqual(balance.damagedQuantity, 1, "damaged_quantity must increase from 0 to 1");
  });

  // TC-F05-03 (Exception - Over-return Rejected)
  it("TC-F05-03: Exception - Over-return Rejected: Order bought 2, already returned 2, returning 1 more -> 400 Bad Request", async () => {
    // 1. Kiểm tra lookup: returnableQty đã về 0
    const lookup = await apiCall(`/api/customer-returns/lookup/${completedOrderCode}`);
    assert.strictEqual(lookup.status, 200);
    assert.strictEqual(lookup.body.items[0].previouslyReturnedQty, 2);
    assert.strictEqual(lookup.body.items[0].returnableQty, 0);

    // 2. Cố tình gửi request trả thêm 1 cái
    const res = await apiCall("/api/customer-returns", {
      method: "POST",
      body: {
        orderCode: completedOrderCode,
        items: [
          {
            orderItemId,
            variantId: variantAId,
            returnQty: 1,
            itemCondition: "RESTOCKABLE",
            returnReason: "Cố tình trả quá số lượng",
          },
        ],
      },
    });

    // 3. Phải bị từ chối với HTTP 400 Bad Request
    assert.ok(res.status === 409 || res.status === 400, "Must be rejected with 409 or 400");
    const errMsg = (res.body.error || res.body.message || "").toLowerCase();
    assert.ok(
      errMsg.includes("exceeds remaining returnable quantity") || errMsg.includes("vượt quá") || errMsg.includes("return quantity"),
      `Expected error message about returnable quantity, got: ${errMsg}`,
    );

    // 4. Tồn kho không đổi (on_hand = 11, damaged = 1)
    const balance = await prisma.inventoryBalance.findFirst({
      where: { businessId, variantId: variantAId, lotItemId: null },
    });
    assert.strictEqual(balance?.quantityOnHand, 11, "quantity_on_hand must remain 11");
    assert.strictEqual(balance?.damagedQuantity, 1, "damaged_quantity must remain 1");
  });

  // TC-F06-01 (Happy Path - Vendor Return)
  it("TC-F06-01: Happy Path - Vendor Return: Return 2 items -> on_hand -2, supplier debt reduced by 2 * unit_price, negative ledger", async () => {
    // 1. Owner xuất trả 2 cái variantB cho NCC
    const returnQty = 2;
    const res = await apiCall("/api/vendor-returns", {
      method: "POST",
      authId: ownerAuthId,
      body: {
        supplierId,
        items: [
          {
            variantId: variantBId,
            returnQty,
            returnUnitPrice: vendorReturnUnitPrice,
          },
        ],
      },
    });

    assert.strictEqual(res.status, 201, `Failed with: ${JSON.stringify(res.body)}`);

    // 2. Kiểm tra tồn kho variantB giảm 2 (từ 10 xuống 8)
    const balance = await prisma.inventoryBalance.findFirst({
      where: { businessId, variantId: variantBId, lotItemId: null },
    });
    assert.ok(balance);
    assert.strictEqual(balance.quantityOnHand, 8, "quantity_on_hand must decrease from 10 to 8");

    // 3. Kiểm tra công nợ NCC giảm đúng bằng 2 * returnUnitPrice
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } });
    const expectedDebt = initialSupplierDebt - returnQty * vendorReturnUnitPrice;
    assert.strictEqual(
      Number(supplier.debtAmount),
      expectedDebt,
      `debt_amount must decrease to ${expectedDebt}`,
    );

    // 4. Kiểm tra ledger âm
    const ledger = await prisma.inventoryLedger.findFirst({
      where: {
        businessId,
        variantId: variantBId,
        transactionType: "VENDOR_RETURN",
        referenceDocId: res.body.id,
      },
    });
    assert.ok(ledger, "InventoryLedger for VENDOR_RETURN must exist");
    assert.strictEqual(ledger.quantityChanged, -2, "quantity_changed must be -2");
    assert.strictEqual(
      Number(ledger.totalCostValue),
      -(returnQty * vendorReturnUnitPrice),
      `total_cost_value must be negative ${-(returnQty * vendorReturnUnitPrice)}`,
    );
  });

  // TC-F06-02 (Business Rule - Exceed Stock Rejected)
  it("TC-F06-02: Business Rule - Exceed Stock Rejected: On-hand is 5, returning 10 -> 400 Bad Request", async () => {
    // Kho chỉ có 5 cái variantC nhưng tạo phiếu trả 10 cái
    const res = await apiCall("/api/vendor-returns", {
      method: "POST",
      authId: ownerAuthId,
      body: {
        supplierId,
        items: [
          {
            variantId: variantCId,
            returnQty: 10,
            returnUnitPrice: vendorReturnUnitPrice,
          },
        ],
      },
    });

    assert.strictEqual(res.status, 400, "Must return 400 Bad Request");
    const errMsg = (res.body.error || res.body.message || "").toLowerCase();
    assert.ok(
      errMsg.includes("insufficient on-hand stock") || errMsg.includes("không đủ") || errMsg.includes("vượt quá"),
      `Expected error about insufficient stock, got: ${errMsg}`,
    );

    // Tồn kho không thay đổi (vẫn là 5)
    const balance = await prisma.inventoryBalance.findFirst({
      where: { businessId, variantId: variantCId, lotItemId: null },
    });
    assert.strictEqual(balance?.quantityOnHand, 5, "quantity_on_hand must remain 5");
  });

  // TC-F06-03 (Authorization - Staff Rejected)
  it("TC-F06-03: Authorization - Staff Rejected: STAFF role calling POST /api/vendor-returns -> 403 Forbidden", async () => {
    const res = await apiCall("/api/vendor-returns", {
      method: "POST",
      authId: staffAuthId, // User có role STAFF trong membership
      body: {
        supplierId,
        items: [
          {
            variantId: variantBId,
            returnQty: 1,
            returnUnitPrice: vendorReturnUnitPrice,
          },
        ],
      },
    });

    assert.strictEqual(res.status, 403, `Staff must be rejected with 403 Forbidden, got ${res.status}`);
  });

  // Extra Test: Lock check (409 Conflict) for both returns
  it("Extra: Variant locked for audit rejects customer return and vendor return with 409", async () => {
    const custRes = await apiCall("/api/customer-returns", {
      method: "POST",
      body: {
        orderCode: completedOrderCode,
        items: [
          {
            variantId: variantLockedId,
            returnQty: 1,
            itemCondition: "RESTOCKABLE",
          },
        ],
      },
    });
    assert.strictEqual(custRes.status, 409, "Customer return with locked variant must return 409");

    const vendRes = await apiCall("/api/vendor-returns", {
      method: "POST",
      authId: ownerAuthId,
      body: {
        supplierId,
        items: [
          {
            variantId: variantLockedId,
            returnQty: 1,
            returnUnitPrice: 50000,
          },
        ],
      },
    });
    assert.strictEqual(vendRes.status, 409, "Vendor return with locked variant must return 409");
  });
});
