import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";

export interface CreateVendorReturnItemInput {
  variantId: string;
  lotId?: string | null;
  returnQty: number;
  returnUnitPrice?: number;
}

export interface CreateVendorReturnInput {
  supplierId: string;
  receiptId?: string | null;
  returnCode?: string;
  items: CreateVendorReturnItemInput[];
}

export interface VendorReturnQuery {
  search?: string;
  page?: number;
  pageSize?: number;
  status?: string;
  supplierId?: string;
}

export class VendorReturnsService {
  /**
   * GET /api/vendor-returns
   * Lấy danh sách phiếu trả NCC của business_id.
   * Nếu user là STAFF, ẩn trường cost_price / returnUnitPrice theo quy định.
   */
  async listReturns(
    businessId: string,
    query: VendorReturnQuery = {},
    userRole: string = "OWNER",
  ) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const where: Prisma.VendorReturnWhereInput = {
      businessId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.search
        ? {
            OR: [
              { returnCode: { contains: query.search, mode: "insensitive" } },
              { supplier: { name: { contains: query.search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const [total, records] = await Promise.all([
      prisma.vendorReturn.count({ where }),
      prisma.vendorReturn.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              phone: true,
              debtAmount: true,
            },
          },
          createdByUser: {
            select: {
              id: true,
              fullName: true,
              email: true,
            },
          },
          vendorReturnItems: {
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

    // Nếu STAFF thì ẩn cost_price và returnUnitPrice
    const isStaff = userRole === "STAFF";
    const data = records.map((vr) => {
      const items = vr.vendorReturnItems.map((item) => {
        const variantObj = item.variant
          ? {
              id: item.variant.id,
              sku: item.variant.sku,
              barcode: item.variant.barcode,
              name: item.variant.template?.name,
              unitOfMeasure: item.variant.template?.unitOfMeasure,
              ...(isStaff ? {} : { costPrice: Number(item.variant.costPrice) }),
            }
          : null;

        return {
          id: item.id,
          variantId: item.variantId,
          lotId: item.lotId,
          returnQty: item.returnQty,
          ...(isStaff ? {} : { returnUnitPrice: Number(item.returnUnitPrice) }),
          variant: variantObj,
          lot: item.lot,
        };
      });

      return {
        id: vr.id,
        returnCode: vr.returnCode,
        createdAt: vr.createdAt,
        status: vr.status,
        ...(isStaff ? {} : { totalReturnValue: Number(vr.totalReturnValue) }),
        supplier: vr.supplier,
        createdByUser: vr.createdByUser,
        vendorReturnItems: items,
      };
    });

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
   * POST /api/vendor-returns
   * Thực hiện trong prisma.$transaction:
   * Rule 1 (RBAC): Chỉ OWNER hoặc có quyền mới được tạo (STAFF -> 403)
   * Rule 2 (Lock & Stock check):
   *   - is_locked_for_audit == true -> 409
   *   - return_qty > quantity_on_hand -> 400
   * Rule 3 (Deduct Stock & Ledger):
   *   - Trừ inventory_balances.quantity_on_hand -= return_qty
   *   - Nếu on_hand == 0 -> set out_of_stock_since = NOW()
   *   - Ghi inventory_ledger: transaction_type = 'VENDOR_RETURN', quantity_changed = -return_qty,
   *     total_cost_value = -return_qty * return_unit_price, reference_doc_type = 'VENDOR_RETURN'
   * Rule 4 (Supplier Debt Reduction):
   *   - suppliers.debt_amount -= total_return_value
   */
  async createReturn(
    businessId: string,
    userId: string,
    body: CreateVendorReturnInput,
    userRole: string = "OWNER",
    permissionCodes: string[] = [],
  ) {
    // Rule 1: RBAC Authorization - Chỉ cho phép role OWNER (STAFF trả lỗi 403)
    if (userRole !== "OWNER") {
      throw new HttpError(
        403,
        "Chỉ chủ cửa hàng (OWNER) mới có quyền tạo phiếu trả hàng nhà cung cấp.",
      );
    }

    if (!body.supplierId) {
      throw new HttpError(400, "Vui lòng chọn nhà cung cấp.");
    }

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new HttpError(400, "Phiếu trả hàng NCC phải có ít nhất một sản phẩm.");
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Kiểm tra nhà cung cấp
      const supplier = await tx.supplier.findFirst({
        where: { id: body.supplierId, businessId },
      });

      if (!supplier) {
        throw new HttpError(404, "Không tìm thấy nhà cung cấp.");
      }

      // 2. Rule 2: Lock & Stock check
      const validatedLines: Array<{
        variantId: string;
        lotId: string | null;
        returnQty: number;
        returnUnitPrice: number;
        balance: { id: string; quantityOnHand: number; outOfStockSince: Date | null };
      }> = [];

      let totalReturnValue = 0;

      for (const item of body.items) {
        const returnQty = Math.trunc(Number(item.returnQty));
        if (!Number.isFinite(returnQty) || returnQty <= 0) {
          throw new HttpError(400, "Số lượng trả hàng phải lớn hơn 0.");
        }

        const variant = await tx.productVariant.findFirst({
          where: { id: item.variantId, businessId },
        });

        if (!variant) {
          throw new HttpError(404, `Không tìm thấy sản phẩm ${item.variantId}.`);
        }

        if (variant.isLockedForAudit) {
          throw new HttpError(409, "Product is currently locked for stock audit");
        }

        const lotId = item.lotId || null;
        const balance = await tx.inventoryBalance.findFirst({
          where: {
            businessId,
            variantId: item.variantId,
            lotId,
          },
        });

        const currentOnHand = balance?.quantityOnHand ?? 0;
        if (returnQty > currentOnHand) {
          throw new HttpError(400, "Insufficient on-hand stock for vendor return");
        }

        const returnUnitPrice =
          item.returnUnitPrice != null && Number.isFinite(Number(item.returnUnitPrice))
            ? Number(item.returnUnitPrice)
            : Number(variant.costPrice);

        if (returnUnitPrice < 0) {
          throw new HttpError(400, "Đơn giá trả hàng không hợp lệ.");
        }

        totalReturnValue += returnQty * returnUnitPrice;

        validatedLines.push({
          variantId: item.variantId,
          lotId,
          returnQty,
          returnUnitPrice,
          balance: {
            id: balance!.id,
            quantityOnHand: currentOnHand,
            outOfStockSince: balance?.outOfStockSince ?? null,
          },
        });
      }

      totalReturnValue = Math.round(totalReturnValue * 100) / 100;

      // 3. Generate returnCode
      const timestamp = Date.now().toString().slice(-6);
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const returnCode =
        body.returnCode?.trim() || `VRET-${timestamp}-${randomSuffix}`;

      // 4. Create vendor_returns record
      const vendorReturn = await tx.vendorReturn.create({
        data: {
          businessId,
          supplierId: supplier.id,
          receiptId: body.receiptId || null,
          returnCode,
          totalReturnValue,
          status: "COMPLETED",
          createdBy: userId,
        },
      });

      // 5. Rule 3: Deduct Stock & Record Immutable Ledger
      for (const line of validatedLines) {
        await tx.vendorReturnItem.create({
          data: {
            returnId: vendorReturn.id,
            variantId: line.variantId,
            lotId: line.lotId,
            returnQty: line.returnQty,
            returnUnitPrice: line.returnUnitPrice,
          },
        });

        const newOnHand = line.balance.quantityOnHand - line.returnQty;
        const outOfStockSince = newOnHand === 0 ? new Date() : line.balance.outOfStockSince;

        await tx.inventoryBalance.update({
          where: { id: line.balance.id },
          data: {
            quantityOnHand: newOnHand,
            outOfStockSince,
            updatedAt: new Date(),
          },
        });

        const totalCostValue = -Math.round(line.returnQty * line.returnUnitPrice * 100) / 100;

        await tx.inventoryLedger.create({
          data: {
            businessId,
            variantId: line.variantId,
            lotId: line.lotId,
            transactionType: "VENDOR_RETURN",
            quantityChanged: -line.returnQty,
            balanceAfter: newOnHand,
            unitCost: line.returnUnitPrice,
            totalCostValue,
            referenceDocType: "VENDOR_RETURN",
            referenceDocId: vendorReturn.id,
            createdBy: userId,
          },
        });
      }

      // 6. Rule 4: Supplier Debt Reduction
      await tx.supplier.update({
        where: { id: supplier.id },
        data: {
          debtAmount: {
            decrement: totalReturnValue,
          },
        },
      });

      return vendorReturn;
    });
  }

  /**
   * GET /api/vendor-returns/:id
   */
  async getReturnById(businessId: string, id: string, userRole: string = "OWNER") {
    const record = await prisma.vendorReturn.findFirst({
      where: { id, businessId },
      include: {
        supplier: true,
        createdByUser: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
        vendorReturnItems: {
          include: {
            variant: {
              include: {
                template: true,
              },
            },
            lot: true,
          },
        },
      },
    });

    if (!record) {
      throw new HttpError(404, "Không tìm thấy phiếu trả hàng nhà cung cấp.");
    }

    const isStaff = userRole === "STAFF";
    if (isStaff) {
      return {
        ...record,
        totalReturnValue: undefined,
        vendorReturnItems: record.vendorReturnItems.map((item) => ({
          ...item,
          returnUnitPrice: undefined,
          variant: item.variant
            ? {
                ...item.variant,
                costPrice: undefined,
              }
            : null,
        })),
      };
    }

    return record;
  }
}

export const vendorReturnsService = new VendorReturnsService();
