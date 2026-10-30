import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";

export interface CreateCustomerReturnItemInput {
  orderItemId?: string;
  variantId: string;
  lotId?: string | null;
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
  exchangeFromReturnId?: string;
  items: CreateCustomerReturnItemInput[];
}

export interface CustomerReturnQuery {
  search?: string;
  page?: number;
  pageSize?: number;
  status?: string;
}

export class CustomerReturnsService {
  /**
   * GET /api/customer-returns
   * Lấy danh sách phiếu trả hàng của cửa hàng (business_id)
   */
  async listReturns(businessId: string, query: CustomerReturnQuery = {}) {
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
                select: {
                  id: true,
                  name: true,
                  phone: true,
                },
              },
            },
          },
          cashier: {
            select: {
              id: true,
              fullName: true,
              email: true,
            },
          },
          shift: {
            select: {
              id: true,
              status: true,
              openedAt: true,
            },
          },
          customerReturnItems: {
            include: {
              variant: {
                include: {
                  template: {
                    select: {
                      name: true,
                      unitOfMeasure: true,
                    },
                  },
                },
              },
              lot: {
                select: {
                  id: true,
                  lotNumber: true,
                  expirationDate: true,
                },
              },
            },
          },
        },
      }),
    ]);

    return {
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  /**
   * GET /api/customer-returns/lookup/:orderCode
   * Tra cứu hóa đơn gốc theo order_code thuộc business_id,
   * trả về các dòng order_items kèm previously_returned_qty và returnable_qty.
   */
  async lookupOrder(businessId: string, orderCode: string) {
    if (!orderCode || !orderCode.trim()) {
      throw new HttpError(400, "Vui lòng cung cấp mã đơn hàng cần tra cứu.");
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
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
        orderItems: {
          include: {
            variant: {
              include: {
                template: {
                  select: {
                    name: true,
                    unitOfMeasure: true,
                    hasLotTracking: true,
                  },
                },
              },
            },
            lot: true,
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

    // Tính previously_returned_qty cho từng orderItem
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
          lotId: item.lotId,
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice),
          unitCost: Number(item.unitCost),
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
          lot: item.lot
            ? {
                id: item.lot.id,
                lotNumber: item.lot.lotNumber,
                manufacturingDate: item.lot.manufacturingDate,
                expirationDate: item.lot.expirationDate,
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

  /**
   * POST /api/customer-returns
   * Thực hiện trong prisma.$transaction:
   * 1. Lock check: product_variants.is_locked_for_audit (409)
   * 2. Cumulative qty check: return_qty <= returnable_qty (400)
   * 3. Stock quarantine routing: RESTOCKABLE -> quantity_on_hand, DAMAGED_QUARANTINE -> damaged_quantity
   * 4. Immutable ledger: transaction_type = 'CUSTOMER_RETURN', +return_qty, unit_cost từ order_items
   * 5. Cash Shift Refund: refund_method === 'CASH' -> cash_transactions (OUT, CUSTOMER_REFUND)
   */
  async createReturn(businessId: string, userId: string, body: CreateCustomerReturnInput) {
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new HttpError(400, "Phiếu trả hàng phải có ít nhất một sản phẩm.");
    }

    // Resolve order
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

    if (!originalOrderId) {
      throw new HttpError(400, "Vui lòng cung cấp originalOrderId hoặc orderCode.");
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Lấy thông tin đơn hàng gốc
      const order = await tx.order.findFirst({
        where: { id: originalOrderId, businessId },
        include: {
          customer: true,
          orderItems: true,
        },
      });

      if (!order) {
        throw new HttpError(404, "Không tìm thấy hóa đơn gốc.");
      }

      if (order.status !== "COMPLETED") {
        throw new HttpError(400, "Chỉ được phép trả hàng cho đơn hàng đã hoàn thành (COMPLETED).");
      }

      // 2. Rule 1: Lock check
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
          throw new HttpError(409, "Product is currently locked for stock audit");
        }
      }

      // 3. Rule 2: Cumulative quantity check & Validate items
      const orderItemMap = new Map(order.orderItems.map((oi) => [oi.id, oi]));

      const validatedLines: Array<{
        orderItem: (typeof order.orderItems)[0];
        variantId: string;
        lotId: string | null;
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
          throw new HttpError(400, "item_condition phải là 'RESTOCKABLE' hoặc 'DAMAGED_QUARANTINE'.");
        }

        // Tìm orderItem tương ứng
        let matchedOrderItem = item.orderItemId ? orderItemMap.get(item.orderItemId) : undefined;
        if (!matchedOrderItem) {
          matchedOrderItem = order.orderItems.find(
            (oi) =>
              oi.variantId === item.variantId &&
              (!item.lotId || oi.lotId === item.lotId),
          );
        }

        if (!matchedOrderItem) {
          throw new HttpError(400, "Sản phẩm trả không tồn tại trong đơn hàng gốc.");
        }

        // Tính số lượng đã trả trước đó
        const returnedAgg = await tx.customerReturnItem.aggregate({
          _sum: { returnQty: true },
          where: {
            orderItemId: matchedOrderItem.id,
            return: {
              businessId,
              status: "COMPLETED",
            },
          },
        });

        const previouslyReturnedQty = returnedAgg._sum.returnQty ?? 0;
        const returnableQty = matchedOrderItem.quantity - previouslyReturnedQty;

        if (returnQty > returnableQty) {
          throw new HttpError(400, "Return quantity exceeds remaining returnable quantity");
        }

        const refundUnitPrice =
          item.refundUnitPrice != null && Number.isFinite(Number(item.refundUnitPrice))
            ? Number(item.refundUnitPrice)
            : Number(matchedOrderItem.unitPrice);

        totalRefundAmount += returnQty * refundUnitPrice;

        validatedLines.push({
          orderItem: matchedOrderItem,
          variantId: item.variantId,
          lotId: item.lotId || matchedOrderItem.lotId || null,
          returnQty,
          refundUnitPrice,
          itemCondition: item.itemCondition,
          returnReason: item.returnReason?.trim() || "Khách trả hàng",
        });
      }

      totalRefundAmount = Math.round(totalRefundAmount * 100) / 100;

      // 4. Resolve shift
      let shiftId = body.shiftId;
      if (!shiftId) {
        const openShift = await tx.cashShift.findFirst({
          where: { businessId, status: "OPEN" },
          orderBy: { openedAt: "desc" },
        });
        shiftId = openShift ? openShift.id : order.shiftId;
      }

      // 5. Generate returnCode
      const timestamp = Date.now().toString().slice(-6);
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const returnCode = `RET-${timestamp}-${randomSuffix}`;

      const refundMethod = body.refundMethod || "CASH";

      // 6. Create customerReturn
      const customerReturn = await tx.customerReturn.create({
        data: {
          businessId,
          shiftId,
          returnCode,
          originalOrderId: order.id,
          isUnverifiedOrigin: false,
          cashierId: userId,
          totalRefundAmount,
          refundMethod,
          status: "COMPLETED",
        },
      });

      // 7. Process items: create return item, routing stock, ledger
      for (const line of validatedLines) {
        await tx.customerReturnItem.create({
          data: {
            returnId: customerReturn.id,
            orderItemId: line.orderItem.id,
            variantId: line.variantId,
            lotId: line.lotId,
            returnQty: line.returnQty,
            refundUnitPrice: line.refundUnitPrice,
            itemCondition: line.itemCondition,
            returnReason: line.returnReason,
          },
        });

        // Tìm hoặc khởi tạo inventory_balance
        let balance = await tx.inventoryBalance.findFirst({
          where: {
            businessId,
            variantId: line.variantId,
            lotId: line.lotId,
          },
        });

        if (!balance) {
          balance = await tx.inventoryBalance.create({
            data: {
              businessId,
              variantId: line.variantId,
              lotId: line.lotId,
              quantityOnHand: 0,
              damagedQuantity: 0,
            },
          });
        }

        let newOnHand = balance.quantityOnHand;

        // Rule 3: Stock quarantine routing
        if (line.itemCondition === "RESTOCKABLE") {
          newOnHand = balance.quantityOnHand + line.returnQty;
          const clearOutOfStock = balance.outOfStockSince && newOnHand > 0 ? null : balance.outOfStockSince;

          balance = await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: {
              quantityOnHand: newOnHand,
              outOfStockSince: clearOutOfStock,
              updatedAt: new Date(),
            },
          });
        } else if (line.itemCondition === "DAMAGED_QUARANTINE") {
          // TUYỆT ĐỐI KHÔNG cộng vào quantityOnHand, chỉ cộng vào damagedQuantity
          balance = await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: {
              damagedQuantity: balance.damagedQuantity + line.returnQty,
              updatedAt: new Date(),
            },
          });
        }

        // Rule 4: Immutable Ledger
        const unitCost = Number(line.orderItem.unitCost);
        const totalCostValue = Math.round(line.returnQty * unitCost * 100) / 100;

        await tx.inventoryLedger.create({
          data: {
            businessId,
            variantId: line.variantId,
            lotId: line.lotId,
            transactionType: "CUSTOMER_RETURN",
            quantityChanged: line.returnQty,
            balanceAfter: newOnHand,
            unitCost,
            totalCostValue,
            referenceDocType: "RETURN",
            referenceDocId: customerReturn.id,
            createdBy: userId,
          },
        });
      }

      // 8. Rule 5: Cash Shift Refund
      if (refundMethod === "CASH" && totalRefundAmount > 0) {
        await tx.cashTransaction.create({
          data: {
            businessId,
            shiftId,
            transactionType: "OUT",
            category: "CUSTOMER_REFUND",
            amount: totalRefundAmount,
            refDocType: "CUSTOMER_RETURN",
            refDocId: customerReturn.id,
            recipientOrPayer: order.customer ? order.customer.name : "Khách lẻ",
            notes: `Hoàn tiền trả hàng cho hóa đơn ${order.orderCode} (Phiếu ${returnCode})`,
            createdBy: userId,
          },
        });
      }

      // 9. Exchange support
      if (body.exchangeFromReturnId) {
        // Link to existing exchange order if requested
        await tx.order.updateMany({
          where: { id: body.exchangeFromReturnId, businessId },
          data: { exchangeFromReturnId: customerReturn.id },
        });
      }

      return customerReturn;
    });
  }

  /**
   * GET /api/customer-returns/:id
   */
  async getReturnById(businessId: string, id: string) {
    const customerReturn = await prisma.customerReturn.findFirst({
      where: { id, businessId },
      include: {
        originalOrder: {
          include: {
            customer: true,
          },
        },
        cashier: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
        shift: true,
        customerReturnItems: {
          include: {
            variant: {
              include: {
                template: {
                  select: {
                    name: true,
                    unitOfMeasure: true,
                  },
                },
              },
            },
            lot: true,
            orderItem: true,
          },
        },
      },
    });

    if (!customerReturn) {
      throw new HttpError(404, "Không tìm thấy phiếu trả hàng.");
    }

    return customerReturn;
  }
}

export const customerReturnsService = new CustomerReturnsService();
