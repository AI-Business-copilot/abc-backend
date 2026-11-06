import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";
import { allocateStock } from "../sales/sales.service";

export interface ExchangeItemInput {
  variantId: string;
  quantity: number;
}

export interface CreateCustomerReturnItemInput {
  orderItemId?: string;
  variantId: string;
  lotId?: string | null;
  lotItemId?: string | null;
  returnQty: number;
  refundUnitPrice?: number;
  itemCondition: "RESTOCKABLE" | "DAMAGED_QUARANTINE";
  returnReason?: string;
}

export interface CreateCustomerReturnInput {
  orderCode?: string;
  originalOrderId?: string;
  shiftId?: string;
  refundMethod?: "CASH" | "BANK_TRANSFER" | "EXCHANGE_OFFSET" | "NONE";
  isUnverifiedOrigin?: boolean;
  exchangeFromReturnId?: string;
  items: CreateCustomerReturnItemInput[];
  exchangeItems?: ExchangeItemInput[];
}

export interface CustomerReturnQuery {
  search?: string;
  page?: number;
  pageSize?: number;
  status?: string;
}

export class CustomerReturnsService {
  async listReturns(businessId: string, query: CustomerReturnQuery = {}, userRole: string = "OWNER") {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const where: Prisma.CustomerReturnWhereInput = {
      businessId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { returnCode: { contains: query.search, mode: "insensitive" } },
              { originalOrder: { orderCode: { contains: query.search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const isStaff = userRole === "STAFF";

    const [total, data] = await Promise.all([
      prisma.customerReturn.count({ where }),
      prisma.customerReturn.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          originalOrder: {
            select: {
              id: true,
              orderCode: true,
              createdAt: true,
              totalNetAmount: true,
              customer: {
                select: { id: true, name: true, phone: true },
              },
            },
          },
          cashier: {
            select: { id: true, fullName: true, email: true },
          },
          shift: {
            select: { id: true, status: true, openedAt: true },
          },
          customerReturnItems: {
            include: {
              variant: {
                include: {
                  template: {
                    select: { name: true, unitOfMeasure: true },
                  },
                },
              },
              lotItem: {
                select: {
                  id: true,
                  lotId: true,
                  expirationDate: true,
                  manufacturingDate: true,
                  lot: {
                    select: { lotNumber: true },
                  },
                },
              },
            },
          },
        },
      }),
    ]);

    const sanitizedData = data.map((r) => ({
      ...r,
      customerReturnItems: r.customerReturnItems.map((item) => ({
        ...item,
        lot: item.lotItem
          ? {
              id: item.lotItem.id,
              lotId: item.lotItem.lotId,
              lotNumber: item.lotItem.lot?.lotNumber,
              expirationDate: item.lotItem.expirationDate,
              manufacturingDate: item.lotItem.manufacturingDate,
            }
          : null,
        variant: item.variant
          ? {
              id: item.variant.id,
              sku: item.variant.sku,
              barcode: item.variant.barcode,
              name: item.variant.template?.name,
              unitOfMeasure: item.variant.template?.unitOfMeasure,
              ...(isStaff ? {} : { costPrice: Number(item.variant.costPrice) }),
            }
          : null,
      })),
    }));

    return {
      items: sanitizedData,
      data: sanitizedData,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  async lookupOrder(businessId: string, orderCode: string, userRole: string = "OWNER") {
    if (!orderCode?.trim()) {
      throw new HttpError(400, "Vui lòng cung cấp mã đơn hàng.");
    }

    const order = await prisma.order.findFirst({
      where: {
        businessId,
        orderCode: orderCode.trim(),
      },
      include: {
        customer: true,
        shift: true,
        cashier: {
          select: { id: true, fullName: true, email: true },
        },
        orderItems: {
          include: {
            variant: {
              include: {
                template: {
                  select: { name: true, unitOfMeasure: true, hasLotTracking: true },
                },
              },
            },
            lotItem: {
              include: {
                lot: true,
              },
            },
          },
        },
      },
    });

    if (!order) {
      throw new HttpError(404, `Không tìm thấy đơn hàng với mã '${orderCode}'.`);
    }

    if (order.status !== "COMPLETED") {
      throw new HttpError(400, "Chỉ được phép trả hàng cho đơn hàng đã hoàn thành (COMPLETED).");
    }

    const isStaff = userRole === "STAFF";

    const itemsWithReturnable = await Promise.all(
      order.orderItems.map(async (item) => {
        const returnedAgg = await prisma.customerReturnItem.aggregate({
          _sum: { returnQty: true },
          where: {
            orderItemId: item.id,
            return: {
              businessId,
              status: "COMPLETED",
            },
          },
        });

        const previouslyReturnedQty = returnedAgg._sum.returnQty ?? 0;
        const returnableQty = Math.max(0, item.quantity - previouslyReturnedQty);

        return {
          id: item.id,
          orderId: item.orderId,
          variantId: item.variantId,
          lotId: item.lotItemId,
          lotItemId: item.lotItemId,
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice),
          ...(isStaff ? {} : { unitCost: Number(item.unitCost) }),
          discountAmount: Number(item.discountAmount),
          subtotal: Number(item.subtotal),
          previouslyReturnedQty,
          returnableQty,
          variant: {
            id: item.variant.id,
            sku: item.variant.sku,
            barcode: item.variant.barcode,
            name: item.variant.template.name,
            unitOfMeasure: item.variant.template.unitOfMeasure,
            isLockedForAudit: item.variant.isLockedForAudit,
          },
          lot: item.lotItem
            ? {
                id: item.lotItem.id,
                lotId: item.lotItem.lotId,
                lotNumber: item.lotItem.lot?.lotNumber,
                manufacturingDate: item.lotItem.manufacturingDate,
                expirationDate: item.lotItem.expirationDate,
              }
            : null,
        };
      }),
    );

    return {
      order: {
        id: order.id,
        orderCode: order.orderCode,
        createdAt: order.createdAt,
        status: order.status,
        totalGrossAmount: Number(order.totalGrossAmount),
        discountAmount: Number(order.discountAmount),
        totalNetAmount: Number(order.totalNetAmount),
        ...(isStaff ? {} : { totalCogsAmount: Number(order.totalCogsAmount), grossProfit: Number(order.grossProfit) }),
        shiftId: order.shiftId,
        customer: order.customer
          ? {
              id: order.customer.id,
              name: order.customer.name,
              phone: order.customer.phone,
            }
          : null,
        cashier: order.cashier,
      },
      items: itemsWithReturnable,
    };
  }

  async createReturn(
    businessId: string,
    userId: string,
    body: CreateCustomerReturnInput,
    userRole: string = "OWNER",
  ) {
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new HttpError(400, "Phiếu trả hàng phải có ít nhất một sản phẩm.");
    }

    if (body.isUnverifiedOrigin && userRole !== "OWNER") {
      throw new HttpError(403, "Chỉ Chủ cửa hàng (OWNER) mới có quyền tạo phiếu trả hàng không có hóa đơn gốc.");
    }

    let originalOrderId = body.originalOrderId;
    if (!originalOrderId && body.orderCode) {
      const foundOrder = await prisma.order.findFirst({
        where: { businessId, orderCode: body.orderCode.trim() },
        select: { id: true, status: true },
      });
      if (!foundOrder) {
        throw new HttpError(404, `Không tìm thấy hóa đơn '${body.orderCode}'.`);
      }
      originalOrderId = foundOrder.id;
    }

    if (!body.isUnverifiedOrigin && !originalOrderId) {
      throw new HttpError(400, "Vui lòng cung cấp originalOrderId hoặc orderCode.");
    }

    return await prisma.$transaction(
      async (tx) => {
        let order: any = null;
        if (originalOrderId) {
          // Row-level lock on order to serialize concurrent return requests (chống race condition)
          await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${originalOrderId}::uuid FOR UPDATE`;

          order = await tx.order.findFirst({
            where: { id: originalOrderId, businessId },
            include: { customer: true, orderItems: { include: { lotItem: { include: { lot: true } } } } },
          });

          if (!order) {
            throw new HttpError(404, "Không tìm thấy hóa đơn gốc.");
          }

          if (order.status !== "COMPLETED") {
            throw new HttpError(400, "Chỉ được phép trả hàng cho đơn hàng đã hoàn thành (COMPLETED).");
          }
        }

        // Lock check
        const variantIds = Array.from(new Set(body.items.map((i) => i.variantId)));
        const variants = await tx.productVariant.findMany({
          where: { id: { in: variantIds }, businessId },
        });
        const variantMap = new Map(variants.map((v) => [v.id, v]));

        for (const item of body.items) {
          const variant = variantMap.get(item.variantId);
          if (!variant) {
            throw new HttpError(404, `Không tìm thấy sản phẩm ${item.variantId}.`);
          }
          if (variant.isLockedForAudit) {
            throw new HttpError(409, "SKU is currently locked for stock audit (F07).");
          }
          const passedLot = item.lotItemId || item.lotId;
          if (passedLot) {
            const lotItem = await tx.productLotItem.findFirst({
              where: {
                businessId,
                OR: [
                  { id: passedLot },
                  { lotId: passedLot, variantId: item.variantId },
                ],
              },
            });
            if (lotItem?.isLockedForAudit) {
              throw new HttpError(409, "Lot is currently locked for stock audit (F07).");
            }
          }
        }

        const orderItemMap = order ? new Map(order.orderItems.map((oi: any) => [oi.id, oi])) : new Map();

        const validatedLines: Array<{
          orderItem?: any;
          variant: any;
          variantId: string;
          lotItemId: string | null;
          returnQty: number;
          refundUnitPrice: number;
          itemCondition: "RESTOCKABLE" | "DAMAGED_QUARANTINE";
          returnReason: string;
        }> = [];

        let totalRefundAmount = 0;

        for (const item of body.items) {
          const returnQty = Math.trunc(Number(item.returnQty));
          if (!Number.isFinite(returnQty) || returnQty <= 0) {
            throw new HttpError(400, "Số lượng trả hàng phải lớn hơn 0.");
          }

          if (item.itemCondition !== "RESTOCKABLE" && item.itemCondition !== "DAMAGED_QUARANTINE") {
            throw new HttpError(400, "itemCondition phải là 'RESTOCKABLE' hoặc 'DAMAGED_QUARANTINE'.");
          }

          const variant = variantMap.get(item.variantId)!;

          let matchedOrderItem: any = undefined;
          const passedLot = item.lotItemId || item.lotId;
          if (order) {
            matchedOrderItem = item.orderItemId ? orderItemMap.get(item.orderItemId) : undefined;
            if (!matchedOrderItem) {
              matchedOrderItem = order.orderItems.find(
                (oi: any) =>
                  oi.variantId === item.variantId &&
                  (!passedLot || oi.lotItemId === passedLot || oi.lotItem?.lotId === passedLot),
              );
            }

            if (!matchedOrderItem) {
              throw new HttpError(400, "Sản phẩm trả không tồn tại trong đơn hàng gốc.");
            }

            const returnedAgg = await tx.customerReturnItem.aggregate({
              _sum: { returnQty: true },
              where: {
                orderItemId: matchedOrderItem.id,
                return: { businessId, status: "COMPLETED" },
              },
            });

            const previouslyReturnedQty = returnedAgg._sum.returnQty ?? 0;
            const returnableQty = matchedOrderItem.quantity - previouslyReturnedQty;

            if (returnQty > returnableQty) {
              throw new HttpError(409, "Return quantity exceeds remaining returnable quantity on original order.");
            }
          }

          let resolvedLotItemId: string | null = null;
          if (passedLot) {
            const lotItem = await tx.productLotItem.findFirst({
              where: {
                businessId,
                OR: [
                  { id: passedLot },
                  { lotId: passedLot, variantId: item.variantId },
                ],
              },
            });
            resolvedLotItemId = lotItem ? lotItem.id : passedLot;
          } else if (matchedOrderItem?.lotItemId) {
            resolvedLotItemId = matchedOrderItem.lotItemId;
          }

          const refundUnitPrice =
            item.refundUnitPrice != null && Number.isFinite(Number(item.refundUnitPrice))
              ? Number(item.refundUnitPrice)
              : matchedOrderItem
                ? Number(matchedOrderItem.unitPrice)
                : Number(variant.basePrice);

          totalRefundAmount += returnQty * refundUnitPrice;

          validatedLines.push({
            orderItem: matchedOrderItem,
            variant,
            variantId: item.variantId,
            lotItemId: resolvedLotItemId,
            returnQty,
            refundUnitPrice,
            itemCondition: item.itemCondition,
            returnReason: item.returnReason?.trim() || "Khách trả hàng",
          });
        }

        totalRefundAmount = Math.round(totalRefundAmount * 100) / 100;

        // Cash Shift check
        const refundMethod = body.refundMethod || "CASH";
        let shiftId = body.shiftId;
        const activeShift = await tx.cashShift.findFirst({
          where: { businessId, userId, status: "OPEN" },
          orderBy: { openedAt: "desc" },
        });
        if (activeShift) {
          const lockedShift = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id"
              FROM "cash_shifts"
             WHERE "id" = ${activeShift.id}::uuid
               AND "business_id" = ${businessId}::uuid
               AND "status" = 'OPEN'
             FOR UPDATE
          `;
          if (!lockedShift.length) throw new HttpError(409, "Open a cash shift owned by the current user first.");
        }

        if (refundMethod === "CASH" && totalRefundAmount > 0) {
          if (!activeShift) {
            throw new HttpError(409, "Open a cash shift owned by the current user first.");
          }
          shiftId = activeShift.id;
        } else if (!shiftId) {
          shiftId = activeShift ? activeShift.id : order?.shiftId;
        }

        if (!shiftId) {
          const anyShift = await tx.cashShift.findFirst({
            where: { businessId },
            orderBy: { openedAt: "desc" },
          });
          if (anyShift) {
            shiftId = anyShift.id;
          } else {
            throw new HttpError(409, "Cần có ít nhất một ca làm việc (Cash Shift) trong cửa hàng.");
          }
        }

        // Generate returnCode
        const timestamp = Date.now().toString().slice(-6);
        const randomSuffix = Math.floor(1000 + Math.random() * 9000);
        const returnCode = `RET-${timestamp}-${randomSuffix}`;

        const customerReturn = await tx.customerReturn.create({
          data: {
            businessId,
            shiftId,
            returnCode,
            originalOrderId: order ? order.id : null,
            isUnverifiedOrigin: Boolean(body.isUnverifiedOrigin),
            cashierId: userId,
            totalRefundAmount,
            refundMethod,
            status: "COMPLETED",
          },
        });

        // Deadlock prevention: sort items by variantId + lotItemId
        validatedLines.sort((a, b) =>
          (a.variantId + (a.lotItemId || "")).localeCompare(b.variantId + (b.lotItemId || "")),
        );

        for (const line of validatedLines) {
          await tx.customerReturnItem.create({
            data: {
              returnId: customerReturn.id,
              orderItemId: line.orderItem ? line.orderItem.id : null,
              variantId: line.variantId,
              lotItemId: line.lotItemId,
              returnQty: line.returnQty,
              refundUnitPrice: line.refundUnitPrice,
              itemCondition: line.itemCondition,
              returnReason: line.returnReason,
            },
          });

          let balance = await tx.inventoryBalance.findFirst({
            where: { businessId, variantId: line.variantId, lotItemId: line.lotItemId },
          });

          if (!balance) {
            balance = await tx.inventoryBalance.create({
              data: {
                businessId,
                variantId: line.variantId,
                lotItemId: line.lotItemId,
                quantityOnHand: 0,
                damagedQuantity: 0,
              },
            });
          }

          let newOnHand = balance.quantityOnHand;

          if (line.itemCondition === "RESTOCKABLE") {
            newOnHand = balance.quantityOnHand + line.returnQty;
            const clearOutOfStock = balance.outOfStockSince && newOnHand > 0 ? null : balance.outOfStockSince;

            await tx.inventoryBalance.update({
              where: { id: balance.id },
              data: {
                quantityOnHand: newOnHand,
                outOfStockSince: clearOutOfStock,
                updatedAt: new Date(),
              },
            });
          } else if (line.itemCondition === "DAMAGED_QUARANTINE") {
            await tx.inventoryBalance.update({
              where: { id: balance.id },
              data: {
                damagedQuantity: balance.damagedQuantity + line.returnQty,
                updatedAt: new Date(),
              },
            });

            if (line.lotItemId) {
              await tx.productLotItem.update({
                where: { id: line.lotItemId },
                data: {
                  status: "QUARANTINED",
                  quarantineQty: { increment: line.returnQty },
                  quarantinedAt: new Date(),
                  quarantinedBy: userId,
                },
              });
            }
          }

          const unitCost = line.orderItem
            ? Number(line.orderItem.unitCost)
            : Number(line.variant.costPrice);
          const totalCostValue = Math.round(line.returnQty * unitCost * 100) / 100;

          await tx.inventoryLedger.create({
            data: {
              businessId,
              variantId: line.variantId,
              lotItemId: line.lotItemId,
              transactionType: "CUSTOMER_RETURN",
              quantityChanged: line.returnQty,
              balanceAfter: newOnHand,
              unitCost,
              totalCostValue,
              referenceDocType: "CUSTOMER_RETURN",
              referenceDocId: customerReturn.id,
              createdBy: userId,
            },
          });
        }

        // Cash flow / Exchange handling
        let exchangeOrder: any = null;
        let delta = 0;

        if (body.exchangeItems && Array.isArray(body.exchangeItems) && body.exchangeItems.length > 0) {
          let exchangeOrderTotal = new Prisma.Decimal(0);
          let exchangeCogs = new Prisma.Decimal(0);
          const exchangeOrderItems: any[] = [];
          const ledgerEntries: any[] = [];

          const sortedExchangeItems = [...body.exchangeItems].sort((a, b) => a.variantId.localeCompare(b.variantId));

          for (const exc of sortedExchangeItems) {
            const requestedQty = Math.trunc(Number(exc.quantity));
            if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
              throw new HttpError(400, "Số lượng sản phẩm đổi phải lớn hơn 0.");
            }

            const { variant, allocations } = await allocateStock(tx, businessId, exc.variantId, requestedQty);

            for (const { balance, quantity } of allocations) {
              const cost = variant.costPrice.mul(quantity);
              exchangeCogs = exchangeCogs.plus(cost);
              const lineSubtotal = variant.basePrice.mul(quantity);
              exchangeOrderTotal = exchangeOrderTotal.plus(lineSubtotal);

              const balanceAfter = balance.quantityOnHand - quantity;
              await tx.inventoryBalance.update({
                where: { id: balance.id },
                data: {
                  quantityOnHand: balanceAfter,
                  updatedAt: new Date(),
                  outOfStockSince: balanceAfter === 0 ? new Date() : null,
                },
              });

              exchangeOrderItems.push({
                variantId: variant.id,
                lotItemId: balance.lotItemId,
                quantity,
                unitPrice: variant.basePrice,
                unitCost: variant.costPrice,
                subtotal: lineSubtotal,
              });

              ledgerEntries.push({
                businessId,
                variantId: variant.id,
                lotItemId: balance.lotItemId,
                transactionType: "POS_SALE" as const,
                quantityChanged: -quantity,
                balanceAfter,
                unitCost: variant.costPrice,
                totalCostValue: cost.negated(),
                referenceDocType: "ORDER",
                createdBy: userId,
              });
            }
          }

          const excCode = `ORD-EXC-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;
          exchangeOrder = await tx.order.create({
            data: {
              businessId,
              shiftId: shiftId!,
              cashierId: userId,
              customerId: order?.customerId || null,
              orderCode: excCode,
              status: "COMPLETED",
              totalGrossAmount: exchangeOrderTotal,
              totalNetAmount: exchangeOrderTotal,
              totalCogsAmount: exchangeCogs,
              grossProfit: exchangeOrderTotal.minus(exchangeCogs),
              exchangeFromReturnId: customerReturn.id,
              orderItems: { create: exchangeOrderItems },
            },
          });

          for (const entry of ledgerEntries) {
            await tx.inventoryLedger.create({
              data: {
                ...entry,
                referenceDocId: exchangeOrder.id,
              },
            });
          }

          delta = exchangeOrderTotal.toNumber() - totalRefundAmount;

          if (delta > 0) {
            // Khách trả thêm
            await tx.orderPayment.create({
              data: {
                orderId: exchangeOrder.id,
                shiftId: exchangeOrder.shiftId,
                paymentMethod: refundMethod === "BANK_TRANSFER" ? "BANK_TRANSFER" : "CASH",
                amount: delta,
                paymentReference: `Bù chênh lệch đổi hàng từ phiếu ${returnCode}`,
              },
            });

            if (refundMethod === "CASH" && activeShift) {
              await tx.cashTransaction.create({
                data: {
                  businessId,
                  shiftId: activeShift.id,
                  transactionType: "IN",
                  category: "POS_SALE",
                  amount: delta,
                  refDocType: "ORDER",
                  refDocId: exchangeOrder.id,
                  recipientOrPayer: order?.customer ? order.customer.name : "Khách lẻ",
                  notes: `Thu chênh lệch đổi hàng cho hóa đơn ${excCode}`,
                  createdBy: userId,
                },
              });
            }

            await tx.customerReturn.update({
              where: { id: customerReturn.id },
              data: { refundMethod: "EXCHANGE_OFFSET" },
            });
          } else if (delta < 0) {
            // Hoàn lại khách
            const refundExcess = Math.abs(delta);
            if (refundMethod === "CASH") {
              if (!activeShift) {
                throw new HttpError(409, "Open a cash shift owned by the current user first.");
              }
              await tx.cashTransaction.create({
                data: {
                  businessId,
                  shiftId: activeShift.id,
                  transactionType: "OUT",
                  category: "CUSTOMER_REFUND",
                  amount: refundExcess,
                  refDocType: "CUSTOMER_RETURN",
                  refDocId: customerReturn.id,
                  recipientOrPayer: order?.customer ? order.customer.name : "Khách lẻ",
                  notes: `Hoàn thừa tiền đổi hàng phiếu ${returnCode}`,
                  createdBy: userId,
                },
              });
            }
          } else {
            // Đổi ngang
            await tx.customerReturn.update({
              where: { id: customerReturn.id },
              data: { refundMethod: "EXCHANGE_OFFSET" },
            });
          }
        } else {
          // Pure return
          if (refundMethod === "CASH" && totalRefundAmount > 0 && activeShift) {
            await tx.cashTransaction.create({
              data: {
                businessId,
                shiftId: activeShift.id,
                transactionType: "OUT",
                category: "CUSTOMER_REFUND",
                amount: totalRefundAmount,
                refDocType: "CUSTOMER_RETURN",
                refDocId: customerReturn.id,
                recipientOrPayer: order?.customer ? order.customer.name : "Khách lẻ",
                notes: `Hoàn tiền trả hàng cho hóa đơn ${order ? order.orderCode : "không hóa đơn"} (Phiếu ${returnCode})`,
                createdBy: userId,
              },
            });
          }
        }

        if (body.exchangeFromReturnId) {
          await tx.order.updateMany({
            where: { id: body.exchangeFromReturnId, businessId },
            data: { exchangeFromReturnId: customerReturn.id },
          });
        }

        return {
          ...customerReturn,
          exchangeOrder: exchangeOrder ? { id: exchangeOrder.id, orderCode: exchangeOrder.orderCode, totalNetAmount: Number(exchangeOrder.totalNetAmount), delta } : null,
        };
      },
      { maxWait: 10000, timeout: 20000 },
    );
  }

  async getReturnById(businessId: string, id: string, userRole: string = "OWNER") {
    const customerReturn = await prisma.customerReturn.findFirst({
      where: { id, businessId },
      include: {
        originalOrder: {
          include: { customer: true },
        },
        cashier: {
          select: { id: true, fullName: true, email: true },
        },
        shift: true,
        customerReturnItems: {
          include: {
            variant: {
              include: {
                template: {
                  select: { name: true, unitOfMeasure: true },
                },
              },
            },
            lotItem: {
              include: {
                lot: true,
              },
            },
            orderItem: true,
          },
        },
      },
    });

    if (!customerReturn) {
      throw new HttpError(404, "Không tìm thấy phiếu trả hàng.");
    }

    const isStaff = userRole === "STAFF";

    return {
      ...customerReturn,
      customerReturnItems: customerReturn.customerReturnItems.map((item) => ({
        ...item,
        lot: item.lotItem
          ? {
              id: item.lotItem.id,
              lotId: item.lotItem.lotId,
              lotNumber: item.lotItem.lot?.lotNumber,
              expirationDate: item.lotItem.expirationDate,
              manufacturingDate: item.lotItem.manufacturingDate,
            }
          : null,
        orderItem: item.orderItem
          ? {
              ...item.orderItem,
              ...(isStaff ? { unitCost: undefined } : {}),
            }
          : null,
        variant: item.variant
          ? {
              ...item.variant,
              ...(isStaff ? { costPrice: undefined } : {}),
            }
          : null,
      })),
    };
  }
}

export const customerReturnsService = new CustomerReturnsService();
