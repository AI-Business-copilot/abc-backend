// F08: the disposal dossier (Thông tư 78/2014, amended by Thông tư 96/2015) and the POS fix
// that keeps quarantined goods off the shelf.

const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
require("ts-node/register/transpile-only");
const { Prisma } = require("@prisma/client");

const BUSINESS = "22222222-2222-4222-8222-222222222222";
const STAFF = "11111111-1111-4111-8111-111111111111";
const OWNER = "99999999-9999-4999-8999-999999999999";
const ORDER = "44444444-4444-4444-8444-444444444444";
const VARIANT = "33333333-3333-4333-8333-333333333333";
const LOT_ITEM = "66666666-6666-4666-8666-666666666666";

const staffActor = { userId: STAFF, role: "STAFF" };
const ownerActor = { userId: OWNER, role: "OWNER" };

let state;
let calls;

const resetState = () => {
  calls = [];
  state = {
    locked: { id: ORDER, status: "PENDING", created_by: STAFF },
    order: {
      id: ORDER,
      businessId: BUSINESS,
      variantId: VARIANT,
      lotItemId: LOT_ITEM,
      scrapCode: "SCRAP-2026-00001",
      scrapQty: 3,
      unitCost: new Prisma.Decimal("10"),
      scrapSource: "SELLABLE_STOCK",
      scrapReason: "Hộp móp",
      status: "PENDING",
      totalLossValue: new Prisma.Decimal("30"),
      compensatedAmount: new Prisma.Decimal("0"),
      causeCode: null,
      disposalMethod: null,
      disposalLocation: null,
      disposalDate: null,
      witnessNames: null,
      createdBy: STAFF,
      createdAt: new Date("2026-11-20T08:00:00Z"),
      approvedAt: null,
      variant: { id: VARIANT, sku: "SKU-1", costPrice: new Prisma.Decimal("10"), template: { name: "Sữa rửa mặt" } },
      lotItem: {
        id: LOT_ITEM,
        expirationDate: new Date("2026-10-15T00:00:00Z"),
        status: "SCRAPPED",
        quarantineQty: null,
        lot: { id: "lot-1", lotNumber: "LOT-2026-01" },
      },
      business: { name: "Công ty ABC", address: "123 Lê Lợi, Quận 1", industryType: "COSMETICS" },
      createdByUser: { id: STAFF, fullName: "Nguyễn Văn A", email: "a@example.com" },
      approvedByUser: null,
      rejectedByUser: null,
      cancelledByUser: null,
    },
    updatedOrder: null,
    ledger: [],
    ledgerFindFirst: null,
    variantTotal: { _sum: { quantityOnHand: 5 } },
  };
};

const db = {
  scrapOrder: {
    findFirst: async (args) => {
      calls.push(["orderFindFirst", args]);
      return state.order;
    },
    findFirstOrThrow: async (args) => {
      calls.push(["orderFindFirstOrThrow", args]);
      return state.order;
    },
    update: async (args) => {
      calls.push(["orderUpdate", args]);
      state.updatedOrder = { ...state.order, ...args.data };
      return state.updatedOrder;
    },
  },
  productVariant: {
    findFirst: async (args) => {
      calls.push(["variantFindFirst", args]);
      return { isLockedForAudit: false };
    },
  },
  productLotItem: {
    findFirst: async (args) => {
      calls.push(["lotItemFindFirst", args]);
      return state.order.lotItem;
    },
    findFirstOrThrow: async (args) => {
      calls.push(["lotItemFindFirstOrThrow", args]);
      return state.order.lotItem;
    },
  },
  inventoryBalance: {
    findFirst: async (args) => {
      calls.push(["balanceFindFirst", args]);
      return { id: "balance-1", quantityOnHand: 10, damagedQuantity: 2 };
    },
    aggregate: async (args) => {
      calls.push(["balanceAggregate", args]);
      return state.variantTotal;
    },
  },
  inventoryLedger: {
    findFirst: async (args) => {
      calls.push(["ledgerFindFirst", args]);
      return state.ledgerFindFirst;
    },
    findMany: async (args) => {
      calls.push(["ledgerFindMany", args]);
      return state.ledger;
    },
    create: async (args) => {
      calls.push(["ledgerCreate", args]);
      state.ledger.push(args.data);
      return args.data;
    },
  },
  $queryRaw: async () => {
    calls.push(["queryRaw"]);
    return [state.locked];
  },
  $transaction: async (work) => work(db),
};

const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client.ts");
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { prisma: db },
};

const storagePath = require.resolve("../src/shared/infrastructure/storage/supabase-storage.ts");
require.cache[storagePath] = {
  id: storagePath,
  filename: storagePath,
  loaded: true,
  exports: {
    uploadObject: async () => {},
    deleteObjects: async () => {},
    createSignedUrls: async () => new Map(),
  },
};

const { ScrapService } = require("../src/modules/inventory/services/scrap.service.ts");
const service = new ScrapService();

beforeEach(resetState);

const call = (name) => calls.find(([key]) => key === name);
const rejects = (fn, statusCode) =>
  assert.rejects(fn, (err) => {
    assert.equal(err.statusCode, statusCode, `expected ${statusCode}, got ${err.statusCode}: ${err.message}`);
    return true;
  });

test("the dossier accepts only the known cause codes and disposal methods", async () => {
  await rejects(() => service.recordDisposalDossier(BUSINESS, staffActor, ORDER, { causeCode: "SPOILLED" }), 400);
  await rejects(() => service.recordDisposalDossier(BUSINESS, staffActor, ORDER, { disposalMethod: "BURN" }), 400);
  await rejects(() => service.recordDisposalDossier(BUSINESS, staffActor, ORDER, {}), 400);

  await service.recordDisposalDossier(BUSINESS, staffActor, ORDER, {
    causeCode: "EXPIRED",
    disposalMethod: "INCINERATION",
    disposalLocation: "Khu xử lý Quận 1",
    witnessNames: "Nguyễn Văn A, Trần Thị B",
  });

  const data = call("orderUpdate")[1].data;
  assert.equal(data.causeCode, "EXPIRED");
  assert.equal(data.disposalMethod, "INCINERATION");
  assert.equal(data.disposalLocation, "Khu xử lý Quận 1");
  assert.equal(data.witnessNames, "Nguyễn Văn A, Trần Thị B");
});

test("the council needs at least two witnesses", async () => {
  await rejects(() => service.recordDisposalDossier(BUSINESS, staffActor, ORDER, { witnessNames: "Nguyễn Văn A" }), 400);
  await rejects(() => service.recordDisposalDossier(BUSINESS, staffActor, ORDER, { witnessNames: "  ,  , " }), 400);

  await service.recordDisposalDossier(BUSINESS, staffActor, ORDER, { witnessNames: "A, B" });
  assert.equal(call("orderUpdate")[1].data.witnessNames, "A, B");
});

test("the recovered amount stays between zero and the loss it comes from", async () => {
  await rejects(() => service.recordDisposalDossier(BUSINESS, staffActor, ORDER, { compensatedAmount: -1 }), 400);
  // The loss is 3 units at 10 = 30, so 30 is the most that can have been recovered.
  await rejects(() => service.recordDisposalDossier(BUSINESS, staffActor, ORDER, { compensatedAmount: 31 }), 400);

  await service.recordDisposalDossier(BUSINESS, staffActor, ORDER, { compensatedAmount: 12.5 });
  assert.equal(call("orderUpdate")[1].data.compensatedAmount.toFixed(2), "12.50");
});

test("a contractor needs an address, and only a pending order can still be completed", async () => {
  await rejects(
    () => service.recordDisposalDossier(BUSINESS, staffActor, ORDER, { disposalMethod: "CONTRACTOR" }),
    400,
  );

  state.locked = { id: ORDER, status: "COMPLETED", created_by: STAFF };
  await rejects(
    () => service.recordDisposalDossier(BUSINESS, staffActor, ORDER, { causeCode: "EXPIRED" }),
    409,
  );
});

test("the owner confirms the physical disposal and the ledger records it", async () => {
  state.locked = { id: ORDER, status: "COMPLETED", created_by: STAFF };
  state.order.status = "COMPLETED";
  state.order.approvedByUser = { id: OWNER, fullName: "Lê Thị C", email: "c@example.com" };
  state.ledgerFindFirst = { id: "ledger-1", balanceAfter: 5 };

  await rejects(() => service.confirmPhysicalDisposal(BUSINESS, staffActor, ORDER, {}), 403);

  const result = await service.confirmPhysicalDisposal(BUSINESS, ownerActor, ORDER, {
    disposalDate: "2026-11-22T10:30:00Z",
  });

  assert.equal(call("orderUpdate")[1].data.disposalDate.toISOString(), "2026-11-22T10:30:00.000Z");

  const ledger = call("ledgerCreate")[1].data;
  assert.equal(ledger.transactionType, "SCRAP_PHYSICALLY_DISPOSED");
  assert.equal(ledger.quantityChanged, 0, "the stock was already written off at approval");
  assert.equal(ledger.referenceDocType, "SCRAP_ORDER");
  assert.equal(ledger.referenceDocId, ORDER);
  assert.equal(ledger.balanceAfter, 5);
  assert.equal(result.disposalLedgerId, "ledger-1");
});

test("a disposal cannot be confirmed twice, nor on an order that was never approved", async () => {
  state.order.disposalDate = new Date("2026-11-22T10:30:00Z");
  await rejects(() => service.confirmPhysicalDisposal(BUSINESS, ownerActor, ORDER, {}), 409);

  state.order.disposalDate = null;
  state.locked = { id: ORDER, status: "PENDING", created_by: STAFF };
  await rejects(() => service.confirmPhysicalDisposal(BUSINESS, ownerActor, ORDER, {}), 409);

  // A date in the future cannot be claimed as a disposal that already happened.
  state.locked = { id: ORDER, status: "COMPLETED", created_by: STAFF };
  await rejects(
    () => service.confirmPhysicalDisposal(BUSINESS, ownerActor, ORDER, { disposalDate: "2099-01-01T00:00:00Z" }),
    400,
  );
});

test("the dossier report carries the six steps, the bảng kê and the deductible loss", async () => {
  state.order.status = "COMPLETED";
  state.order.approvedByUser = { id: OWNER, fullName: "Lê Thị C", email: "c@example.com" };
  state.order.approvedAt = new Date("2026-11-21T14:00:00Z");
  state.order.causeCode = "EXPIRED";
  state.order.disposalMethod = "INCINERATION";
  state.order.disposalLocation = "Khu xử lý Quận 1";
  state.order.witnessNames = "Nguyễn Văn A, Trần Thị B";
  state.order.disposalDate = new Date("2026-11-22T10:30:00Z");
  state.order.compensatedAmount = new Prisma.Decimal("10");
  state.ledger = [
    {
      createdAt: new Date("2026-11-15T00:00:00Z"),
      transactionType: "PURCHASE_RECEIPT",
      quantityChanged: 3,
      unitCost: new Prisma.Decimal("10"),
      totalCostValue: new Prisma.Decimal("30"),
      referenceDocType: "PURCHASE_RECEIPT",
      referenceDocId: "pr-1",
    },
    {
      createdAt: new Date("2026-11-22T00:00:00Z"),
      transactionType: "SCRAP_DISPOSAL",
      quantityChanged: -3,
      unitCost: new Prisma.Decimal("10"),
      totalCostValue: new Prisma.Decimal("30"),
      referenceDocType: "SCRAP_ORDER",
      referenceDocId: ORDER,
    },
  ];

  const report = await service.generateDossierReport(BUSINESS, ORDER);

  assert.equal(report.scrapCode, "SCRAP-2026-00001");
  assert.equal(report.businessName, "Công ty ABC");
  assert.equal(report.step1_council.leader, "Lê Thị C");
  assert.equal(report.step1_council.accountant, "Trần Thị B");
  assert.equal(report.step2_inspection.lotNumber, "LOT-2026-01");
  assert.equal(report.step2_inspection.quantity, 3);
  assert.equal(report.step3_decision.causeCode, "EXPIRED");
  assert.deepEqual(report.step3_decision.witnesses, ["Nguyễn Văn A", "Trần Thị B"]);
  assert.equal(report.step5_disposal.actualDate, "2026-11-22T10:30:00.000Z");

  const bangKe = report.step6_archive_bangke.bangKeXuatNhapTon;
  assert.equal(bangKe.length, 2);
  assert.equal(bangKe[0].transactionType, "PURCHASE_RECEIPT");
  assert.equal(bangKe[1].quantity, -3);

  // Only the part of the loss that was not compensated may be deducted.
  assert.equal(report.tax_fields.totalLossValue, 30);
  assert.equal(report.tax_fields.compensatedAmount, 10);
  assert.equal(report.tax_fields.deductibleLoss, 20);
});

test("the dossier report is only written for an approved order", async () => {
  await rejects(() => service.generateDossierReport(BUSINESS, ORDER), 409);
});
