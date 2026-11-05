import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";

export interface CreateVendorReturnItemInput {
  variantId: string;
  lotId?: string | null;
  returnQty: number;
  returnUnitPrice?: number;
  source?: "SELLABLE" | "DAMAGED_STOCK";
  itemCondition?: "RESTOCKABLE" | "DAMAGED_QUARANTINE";
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
          returnId: item.returnId,
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
        supplierId: vr.supplierId,
        receiptId: vr.receiptId,
        supplier: vr.supplier,
        createdByUser: vr.createdByUser,
        items,
      };
    });

    return {
      items: data,
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  async getSuppliers(businessId: string) {
    const suppliers = await prisma.supplier.findMany({
      where: { businessId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        phone: true,
        contactPerson: true,
        debtAmount: true,
      },
    });
    return suppliers;
  }

  async createReturn(
    businessId: string,
    userId: string,
    body: CreateVendorReturnInput,
    userRole: string = "OWNER",
    _permissionCodes: string[] = [],
  ) {
    if (userRole !== "OWNER") {
      throw new HttpError(
        403,
        "Chỉ Chủ doanh nghiệp (OWNER) mới có quyền tạo phiếu trả hàng cho Nhà cung cấp.",
      );
    }

    if (!body.supplierId) {
      throw new HttpError(400, "Vui lòng chọn nhà cung cấp.");
    }

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new HttpError(400, "Phiếu trả hàng NCC phải có ít nhất một sản phẩm.");
    }

    return await prisma.$transaction(
      async (tx) => {
        // 1. Kiểm tra nhà cung cấp
        const supplier = await tx.supplier.findFirst({
          where: { id: body.supplierId, businessId },
        });

        if (!supplier) {
          throw new HttpError(404, "Không tìm thấy nhà cung cấp.");
        }

        // 1.1 Kiểm tra receiptId nếu có
        if (body.receiptId) {
          const receipt = await tx.purchaseReceipt.findFirst({
            where: { id: body.receiptId, businessId },
          });
          if (!receipt || receipt.status !== "RECEIVED") {
            throw new HttpError(404, "Phiếu nhập kho không tồn tại hoặc chưa hoàn tất (phải ở trạng thái RECEIVED).");
          }
        }

        // 2. Lock & Stock check
        const validatedLines: Array<{
          variantId: string;
          lotId: string | null;
          returnQty: number;
          returnUnitPrice: number;
          isDamaged: boolean;
          balance: { id: string; quantityOnHand: number; damagedQuantity: number; outOfStockSince: Date | null };
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
          if (lotId) {
            const lot = await tx.productLot.findFirst({
              where: { id: lotId, businessId },
            });
            if (lot?.isLockedForAudit) {
              throw new HttpError(409, "Lot is currently locked for stock audit (F07).");
            }
          }

          const balance = await tx.inventoryBalance.findFirst({
            where: {
              businessId,
              variantId: item.variantId,
              lotId,
            },
          });

          const isDamaged = item.source === "DAMAGED_STOCK" || item.itemCondition === "DAMAGED_QUARANTINE";
          const currentStock = isDamaged ? (balance?.damagedQuantity ?? 0) : (balance?.quantityOnHand ?? 0);

          if (returnQty > currentStock) {
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
            isDamaged,
            balance: {
              id: balance!.id,
              quantityOnHand: balance?.quantityOnHand ?? 0,
              damagedQuantity: balance?.damagedQuantity ?? 0,
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

        // Deadlock prevention: sort items by variantId + lotId
        validatedLines.sort((a, b) => (a.variantId + (a.lotId || "")).localeCompare(b.variantId + (b.lotId || "")));

        // 5. Deduct Stock & Record Immutable Ledger
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

          let newOnHand = line.balance.quantityOnHand;

          if (line.isDamaged) {
            await tx.inventoryBalance.update({
              where: { id: line.balance.id },
              data: {
                damagedQuantity: line.balance.damagedQuantity - line.returnQty,
                updatedAt: new Date(),
              },
            });
            if (line.lotId) {
              await tx.productLot.update({
                where: { id: line.lotId },
                data: {
                  quarantineQty: { decrement: line.returnQty },
                },
              });
            }
          } else {
            newOnHand = line.balance.quantityOnHand - line.returnQty;
            const outOfStockSince = newOnHand === 0 ? new Date() : line.balance.outOfStockSince;

            await tx.inventoryBalance.update({
              where: { id: line.balance.id },
              data: {
                quantityOnHand: newOnHand,
                outOfStockSince,
                updatedAt: new Date(),
              },
            });
          }

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

        // 6. Supplier Debt Reduction
        await tx.supplier.update({
          where: { id: supplier.id },
          data: {
            debtAmount: {
              decrement: totalReturnValue,
            },
          },
        });

        return vendorReturn;
      },
      { maxWait: 10000, timeout: 20000 },
    );
  }

  async getReturnById(businessId: string, id: string, userRole: string = "OWNER") {
    const record = await prisma.vendorReturn.findFirst({
      where: { id, businessId },
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            phone: true,
            contactPerson: true,
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
            lot: true,
          },
        },
      },
    });

    if (!record) {
      throw new HttpError(404, "Không tìm thấy phiếu trả hàng nhà cung cấp.");
    }

    const isStaff = userRole === "STAFF";
    const items = record.vendorReturnItems.map((item) => {
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
        returnId: item.returnId,
        variantId: item.variantId,
        lotId: item.lotId,
        returnQty: item.returnQty,
        ...(isStaff ? {} : { returnUnitPrice: Number(item.returnUnitPrice) }),
        variant: variantObj,
        lot: item.lot,
      };
    });

    return {
      id: record.id,
      returnCode: record.returnCode,
      createdAt: record.createdAt,
      status: record.status,
      ...(isStaff ? {} : { totalReturnValue: Number(record.totalReturnValue) }),
      supplierId: record.supplierId,
      receiptId: record.receiptId,
      supplier: record.supplier,
      createdByUser: record.createdByUser,
      items,
    };
  }
}

export const vendorReturnsService = new VendorReturnsService();
