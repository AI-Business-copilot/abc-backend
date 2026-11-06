import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { HttpError } from "../../shared/http/http-error";

export interface CreateVendorReturnItemInput {
  variantId: string;
  lotId?: string | null;
  lotItemId?: string | null;
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
              supplierCode: true,
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
              lotItem: {
                select: {
                  id: true,
                  lotId: true,
                  expirationDate: true,
                  manufacturingDate: true,
                  lot: {
                    select: {
                      lotNumber: true,
                    },
                  },
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
          lotId: item.lotItemId,
          lotItemId: item.lotItemId,
          returnQty: item.returnQty,
          ...(isStaff ? {} : { returnUnitPrice: Number(item.returnUnitPrice) }),
          variant: variantObj,
          lot: item.lotItem
            ? {
                id: item.lotItem.id,
                lotId: item.lotItem.lotId,
                lotNumber: item.lotItem.lot?.lotNumber,
                expirationDate: item.lotItem.expirationDate,
                manufacturingDate: item.lotItem.manufacturingDate,
              }
            : null,
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
        supplier: vr.supplier ? {
          ...vr.supplier,
          currentDebt: Number(vr.supplier.debtAmount ?? 0),
        } : null,
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
      where: { businessId, isActive: true },
      select: {
        id: true,
        supplierCode: true,
        name: true,
        phone: true,
        debtAmount: true,
      },
      orderBy: { name: "asc" },
    });

    return suppliers.map((s) => ({
      ...s,
      currentDebt: Number(s.debtAmount ?? 0),
    }));
  }

  async createReturn(
    businessId: string,
    userId: string,
    body: CreateVendorReturnInput,
    userRole: string = "OWNER",
    permissionCodes: string[] = [],
  ) {
    const hasPermission = userRole === "OWNER" || permissionCodes.includes("vendor_returns.create");
    if (!hasPermission) {
      throw new HttpError(403, "Chỉ Chủ cửa hàng (OWNER) mới có quyền tạo phiếu trả hàng cho nhà cung cấp.");
    }

    if (!body.supplierId) {
      throw new HttpError(400, "Vui lòng chọn nhà cung cấp.");
    }

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new HttpError(400, "Phiếu trả hàng phải có ít nhất một sản phẩm.");
    }

    return await prisma.$transaction(
      async (tx) => {
        // 1. Check Supplier & Row Lock
        await tx.$queryRaw`SELECT id FROM "suppliers" WHERE id = ${body.supplierId}::uuid FOR UPDATE`;

        const supplier = await tx.supplier.findFirst({
          where: { id: body.supplierId, businessId },
        });

        if (!supplier) {
          throw new HttpError(404, "Không tìm thấy nhà cung cấp.");
        }

        if (!supplier.isActive) {
          throw new HttpError(400, "Nhà cung cấp đã ngừng hoạt động.");
        }

        // 2. Validate Items & Stock Lock
        const validatedLines: Array<{
          variantId: string;
          lotItemId: string | null;
          returnQty: number;
          returnUnitPrice: number;
          isDamaged: boolean;
          balance: {
            id: string;
            quantityOnHand: number;
            damagedQuantity: number;
            outOfStockSince: Date | null;
          };
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

          const passedLot = item.lotItemId || item.lotId;
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
            if (lotItem?.isLockedForAudit) {
              throw new HttpError(409, "Lot is currently locked for stock audit (F07).");
            }
            resolvedLotItemId = lotItem ? lotItem.id : passedLot;
          }

          const balance = await tx.inventoryBalance.findFirst({
            where: {
              businessId,
              variantId: item.variantId,
              lotItemId: resolvedLotItemId,
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
            lotItemId: resolvedLotItemId,
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

        // Deadlock prevention: sort items by variantId + lotItemId
        validatedLines.sort((a, b) =>
          (a.variantId + (a.lotItemId || "")).localeCompare(b.variantId + (b.lotItemId || "")),
        );

        // 5. Deduct Stock & Record Immutable Ledger
        for (const line of validatedLines) {
          await tx.vendorReturnItem.create({
            data: {
              returnId: vendorReturn.id,
              variantId: line.variantId,
              lotItemId: line.lotItemId,
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
            if (line.lotItemId) {
              await tx.productLotItem.update({
                where: { id: line.lotItemId },
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
              lotItemId: line.lotItemId,
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
            updatedAt: new Date(),
          },
        });

        return {
          ...vendorReturn,
          totalReturnValue,
          debtReduced: totalReturnValue,
        };
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
            supplierCode: true,
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
            lotItem: {
              include: {
                lot: true,
              },
            },
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
        lotId: item.lotItemId,
        lotItemId: item.lotItemId,
        returnQty: item.returnQty,
        ...(isStaff ? {} : { returnUnitPrice: Number(item.returnUnitPrice) }),
        variant: variantObj,
        lot: item.lotItem
          ? {
              id: item.lotItem.id,
              lotId: item.lotItem.lotId,
              lotNumber: item.lotItem.lot?.lotNumber,
              expirationDate: item.lotItem.expirationDate,
              manufacturingDate: item.lotItem.manufacturingDate,
            }
          : null,
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
      supplier: record.supplier ? {
        ...record.supplier,
        currentDebt: Number(record.supplier.debtAmount ?? 0),
      } : null,
      createdByUser: record.createdByUser,
      items,
    };
  }
}

export const vendorReturnsService = new VendorReturnsService();
