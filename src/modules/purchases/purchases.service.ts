import { activeFilter } from "./suppliers.input";
import { Prisma } from "@prisma/client";

import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";
import { filters, pagination, uuid, type PurchaseQuery } from "./purchases.query";

const ORDER_STATUSES = ["ORDERED", "PARTIALLY_RECEIVED", "COMPLETED", "CLOSED_SHORT", "CANCELLED"];
const RECEIPT_STATUSES = ["RECEIVED", "CANCELLED"];
const creator = { select: { id: true, fullName: true } } as const;
const supplier = { select: { id: true, name: true, phone: true, contactPerson: true } } as const;
const variant = {
  select: {
    id: true, sku: true, barcode: true,
    template: { select: { name: true, unitOfMeasure: true, hasLotTracking: true } },
  },
} as const;
const receiptInclude = { supplier, createdByUser: creator } as const;
const orderInclude = {
  supplier, createdByUser: creator,
  purchaseOrderItems: { orderBy: { id: "asc" }, include: { variant } },
  purchaseReceipts: { orderBy: [{ receivedAt: "asc" }, { id: "asc" }], include: receiptInclude },
} satisfies Prisma.PurchaseOrderInclude;

function orderResult(row: Prisma.PurchaseOrderGetPayload<{ include: typeof orderInclude }>) {
  // Cancelled deliveries stay visible in history but do not contribute to payment totals.
  const receipts = row.purchaseReceipts.filter((receipt) => receipt.status === "RECEIVED");
  const sum = (field: "totalAmount" | "paidAmount") => receipts.reduce((total, receipt) => total.plus(receipt[field]), new Prisma.Decimal(0));
  const totalReceivedAmount = sum("totalAmount");
  const paidAmount = sum("paidAmount");
  return {
    ...row,
    purchaseOrderItems: row.purchaseOrderItems.map((item) => ({
      ...item,
      subtotal: item.unitPrice.mul(item.orderedQty).toFixed(2),
      remainingQty: Math.max(0, item.orderedQty - item.receivedQty),
    })),
    purchaseReceipts: row.purchaseReceipts.map(receiptResult),
    totals: {
      orderedQty: row.purchaseOrderItems.reduce((sum, item) => sum + item.orderedQty, 0),
      receivedQty: row.purchaseOrderItems.reduce((sum, item) => sum + item.receivedQty, 0),
      orderedAmount: row.purchaseOrderItems.reduce((sum, item) => sum.plus(item.unitPrice.mul(item.orderedQty)), new Prisma.Decimal(0)).toFixed(2),
      receivedAmount: totalReceivedAmount.toFixed(2),
      paidAmount: paidAmount.toFixed(2),
      debtAmount: totalReceivedAmount.minus(paidAmount).toFixed(2),
    },
  };
}

function receiptResult<T extends { totalAmount: Prisma.Decimal; paidAmount: Prisma.Decimal }>(row: T) {
  return { ...row, debtAmount: row.totalAmount.minus(row.paidAmount).toFixed(2) };
}

export class PurchasesService {
  async listOrders(businessId: string, query: PurchaseQuery) {
    const f = filters(query, ORDER_STATUSES);
    const where: Prisma.PurchaseOrderWhereInput = {
      businessId, supplierId: f.supplierId, status: f.status, orderDate: f.dateRange,
      ...(f.search ? { OR: [
        { poCode: { contains: f.search, mode: "insensitive" } },
        { supplier: { name: { contains: f.search, mode: "insensitive" } } },
        { purchaseOrderItems: { some: { variant: { sku: { contains: f.search, mode: "insensitive" } } } } },
      ] } : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.purchaseOrder.findMany({ where, include: orderInclude, orderBy: [{ orderDate: "desc" }, { id: "desc" }], skip: f.skip, take: f.pageSize }),
      prisma.purchaseOrder.count({ where }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { items: rows.map(orderResult), pagination: pagination(f.page, f.pageSize, total) };
  }

  async getOrder(businessId: string, id: string) {
    const row = await prisma.purchaseOrder.findFirst({ where: { id: uuid(id, "id"), businessId }, include: orderInclude });
    if (!row) throw new HttpError(404, "Purchase order not found.");
    return orderResult(row);
  }

  async listReceipts(businessId: string, query: PurchaseQuery) {
    const f = filters(query, RECEIPT_STATUSES);
    const where: Prisma.PurchaseReceiptWhereInput = {
      businessId, supplierId: f.supplierId, poId: f.poId, status: f.status, receivedAt: f.dateRange,
      ...(f.search ? { OR: [
        { receiptCode: { contains: f.search, mode: "insensitive" } },
        { supplier: { name: { contains: f.search, mode: "insensitive" } } },
        { po: { poCode: { contains: f.search, mode: "insensitive" } } },
        { purchaseReceiptItems: { some: { variant: { sku: { contains: f.search, mode: "insensitive" } } } } },
      ] } : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.purchaseReceipt.findMany({
        where, include: { ...receiptInclude, po: { select: { id: true, poCode: true } } },
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }], skip: f.skip, take: f.pageSize,
      }),
      prisma.purchaseReceipt.count({ where }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { items: rows.map(receiptResult), pagination: pagination(f.page, f.pageSize, total) };
  }

  async getReceipt(businessId: string, id: string) {
    const receiptId = uuid(id, "id");
    return prisma.$transaction(async (tx) => {
      const row = await tx.purchaseReceipt.findFirst({
        where: { id: receiptId, businessId },
        include: {
          ...receiptInclude, po: { select: { id: true, poCode: true, status: true } },
          purchaseReceiptItems: {
            orderBy: { id: "asc" }, include: {
              variant, lot: { select: { id: true, lotNumber: true, manufacturingDate: true, expirationDate: true } },
              poItem: { select: { id: true, orderedQty: true, receivedQty: true, unitPrice: true } },
            },
          },
        },
      });
      if (!row) throw new HttpError(404, "Purchase receipt not found.");
      const ledger = await tx.inventoryLedger.findMany({
        where: { businessId, referenceDocId: receiptId, OR: [
          { transactionType: "PURCHASE_RECEIPT" }, { referenceDocType: "PURCHASE_RECEIPT_CORRECTION" },
        ] },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return {
        ...receiptResult(row),
        purchaseReceiptItems: row.purchaseReceiptItems.map((item) => ({ ...item, subtotal: item.actualCost.mul(item.receivedQty).toFixed(2) })),
        inventoryLedger: ledger,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async listSuppliers(businessId: string, query: PurchaseQuery) {
    const f = filters(query, []);
    const where: Prisma.SupplierWhereInput = {
      businessId, isActive: activeFilter(query.isActive),
      ...(f.search ? { OR: [
        { supplierCode: { contains: f.search, mode: "insensitive" } },
        { email: { contains: f.search, mode: "insensitive" } },
        { name: { contains: f.search, mode: "insensitive" } },
        { phone: { contains: f.search, mode: "insensitive" } },
        { contactPerson: { contains: f.search, mode: "insensitive" } },
      ] } : {}),
    };
    const [items, total] = await prisma.$transaction([
      prisma.supplier.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], skip: f.skip, take: f.pageSize }),
      prisma.supplier.count({ where }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { items, pagination: pagination(f.page, f.pageSize, total) };
  }
}

export const purchasesService = new PurchasesService();
