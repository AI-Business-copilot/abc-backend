import { Prisma } from "@prisma/client";

import { HttpError } from "../../shared/http/http-error";
import { prisma } from "../../shared/infrastructure/database/prisma.client";

const shiftInclude = {
  user: { select: { id: true, fullName: true } },
  cashTransactions: {
    orderBy: { createdAt: "desc" as const },
    include: { createdByUser: { select: { id: true, fullName: true } } },
  },
  closeReviews: {
    orderBy: { revision: "desc" as const },
    take: 1,
  },
  incomingHandoff: {
    include: {
      previousShift: {
        select: {
          id: true,
          closedAt: true,
          user: { select: { fullName: true } },
        },
      },
      reviewRecords: { orderBy: { revision: "desc" as const }, take: 1 },
    },
  },
};

const shiftHistoryInclude = {
  user: { select: { id: true, fullName: true } },
  closeReviews: { orderBy: { revision: "desc" as const }, take: 1 },
  incomingHandoff: { include: { reviewRecords: { orderBy: { revision: "desc" as const }, take: 1 } } },
};

const incomingCategories = new Set(["SALE_CASH", "OTHER_IN"]);
const outgoingCategories = new Set(["CASH_EXPENSE", "CUSTOMER_REFUND", "OTHER_OUT"]);
const maximumAmount = new Prisma.Decimal("9999999999.99");

function parseMoney(value: unknown, field: string) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new HttpError(400, `${field} phải là số tiền hợp lệ.`);
  }

  const raw = String(value).trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) {
    throw new HttpError(400, `${field} phải có tối đa 2 chữ số thập phân và không vượt quá 9.999.999.999,99.`);
  }
  return new Prisma.Decimal(raw);
}

function calculateExpectedCash(
  openingCash: Prisma.Decimal,
  transactions: { transactionType: string; amount: Prisma.Decimal }[],
) {
  return transactions.reduce(
    (total, transaction) =>
      transaction.transactionType === "IN"
        ? total.plus(transaction.amount)
        : total.minus(transaction.amount),
    openingCash,
  );
}

function requireText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1000) {
    throw new HttpError(400, `${field} là bắt buộc và không được vượt quá 1.000 ký tự.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 1000) {
    throw new HttpError(400, `${field} không được vượt quá 1.000 ký tự.`);
  }
  return value.trim() || null;
}

function presentHandoff<T extends {
  handedOverCash: Prisma.Decimal;
  receivedCash: Prisma.Decimal;
  differenceCash: Prisma.Decimal;
  [key: string]: unknown;
}>(handoff: T, canReconcile: boolean) {
  if (canReconcile) return handoff;
  const {
    handedOverCash: _handedOverCash,
    receivedCash: _receivedCash,
    differenceCash: _differenceCash,
    ...safe
  } = handoff;
  return { ...safe, isMatched: handoff.differenceCash.isZero() };
}

function presentShift<T extends {
  expectedCash: Prisma.Decimal | null;
  differenceCash: Prisma.Decimal | null;
  closeReviews?: { expectedCash: Prisma.Decimal; actualCash: Prisma.Decimal; differenceCash: Prisma.Decimal }[];
  incomingHandoff?: {
    handedOverCash: Prisma.Decimal;
    receivedCash: Prisma.Decimal;
    differenceCash: Prisma.Decimal;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}>(shift: T, canReconcile: boolean) {
  const safe = {
    ...shift,
    incomingHandoff: shift.incomingHandoff
      ? presentHandoff(shift.incomingHandoff, canReconcile)
      : null,
  };
  if (canReconcile) return safe;

  const {
    expectedCash: _expectedCash,
    differenceCash: _differenceCash,
    closeReviews,
    ...redacted
  } = safe;
  return {
    ...redacted,
    closeReviews: closeReviews?.map((review) => {
      const { expectedCash: _expected, differenceCash: _difference, ...reviewSafe } = review;
      return reviewSafe;
    }),
  };
}

export class CashShiftsService {
  async getSummary(businessId: string, canReconcile: boolean) {
    const [current, shifts] = await Promise.all([
      prisma.cashShift.findFirst({
        where: { businessId, status: "OPEN" },
        include: shiftInclude,
      }),
      prisma.cashShift.findMany({
        where: { businessId },
        orderBy: { openedAt: "desc" },
        take: 20,
        include: shiftHistoryInclude,
      }),
    ]);

    return {
      currentShift: current
        ? {
            ...presentShift(current, canReconcile),
            ...(canReconcile
              ? {
                  systemExpectedCash: calculateExpectedCash(
                    current.openingCash,
                    current.cashTransactions,
                  ).toFixed(2),
                }
              : {}),
          }
        : null,
      shifts: shifts.map((shift) => presentShift(shift, canReconcile)),
    };
  }

  async previewHandoff(businessId: string, openingCashInput: unknown, canReconcile: boolean) {
    const openingCash = parseMoney(openingCashInput, "Tiền đầu ca");
    const previousShift = await prisma.cashShift.findFirst({
      where: {
        businessId,
        status: "CLOSED",
        actualCash: { not: null },
        closedAt: { not: null },
        outgoingHandoff: null,
      },
      orderBy: [{ closedAt: "desc" }, { openedAt: "desc" }],
      select: { id: true, actualCash: true },
    });

    if (!previousShift?.actualCash) {
      return { hasPreviousShift: false, isMatched: true, requiresExplanation: false };
    }

    const difference = openingCash.minus(previousShift.actualCash);
    return {
      hasPreviousShift: true,
      isMatched: difference.isZero(),
      requiresExplanation: !difference.isZero(),
      ...(canReconcile
        ? {
            previousShiftId: previousShift.id,
            handedOverCash: previousShift.actualCash.toFixed(2),
            receivedCash: openingCash.toFixed(2),
            differenceCash: difference.toFixed(2),
          }
        : {}),
    };
  }

  async openShift(
    businessId: string,
    userId: string,
    body: Record<string, unknown>,
    canReconcile: boolean,
  ) {
    const openingCash = parseMoney(body.openingCash, "Tiền đầu ca");
    const explanation = optionalText(body.handoffExplanation, "Lý do chênh lệch bàn giao");

    try {
      const result = await prisma.$transaction(async (tx) => {
        const previousShift = await tx.cashShift.findFirst({
          where: {
            businessId,
            status: "CLOSED",
            actualCash: { not: null },
            closedAt: { not: null },
            outgoingHandoff: null,
          },
          orderBy: [{ closedAt: "desc" }, { openedAt: "desc" }],
          select: { id: true, actualCash: true },
        });
        const difference = previousShift?.actualCash
          ? openingCash.minus(previousShift.actualCash)
          : null;
        if (difference && !difference.isZero() && !explanation) {
          throw new HttpError(400, "Cần nhập lý do khi số tiền đầu ca lệch với số tiền bàn giao.");
        }

        const shift = await tx.cashShift.create({
          data: { businessId, userId, openingCash, status: "OPEN" },
        });

        const handoff = previousShift?.actualCash && difference
          ? await tx.cashShiftHandoff.create({
              data: {
                businessId,
                previousShiftId: previousShift.id,
                nextShiftId: shift.id,
                handedOverCash: previousShift.actualCash,
                receivedCash: openingCash,
                differenceCash: difference,
                recordedBy: userId,
                status: difference.isZero() ? "APPROVED" : "PENDING_REVIEW",
                explanation,
                ...(!difference.isZero()
                  ? {
                      reviewRecords: {
                        create: {
                          businessId,
                          revision: 1,
                          explanation: explanation!,
                          submittedBy: userId,
                          status: "PENDING_REVIEW",
                        },
                      },
                    }
                  : {}),
              },
              include: { previousShift: { select: { id: true, closedAt: true } } },
            })
          : null;

        return { shift, handoff };
      });

      return {
        ...result,
        handoff: result.handoff
          ? presentHandoff(result.handoff, canReconcile)
          : null,
        handoffMatched: result.handoff ? result.handoff.differenceCash.isZero() : true,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new HttpError(409, "Két đang có một ca chưa đóng. Hãy đóng ca hiện tại trước khi mở ca mới.");
      }
      throw error;
    }
  }

  async recordTransaction(
    businessId: string,
    userId: string,
    shiftId: string,
    body: Record<string, unknown>,
  ) {
    const transactionType = body.transactionType;
    const category = body.category;
    if (transactionType !== "IN" && transactionType !== "OUT") {
      throw new HttpError(400, "Loại giao dịch không hợp lệ.");
    }
    if (
      typeof category !== "string" ||
      !(transactionType === "IN" ? incomingCategories : outgoingCategories).has(category)
    ) {
      throw new HttpError(400, "Danh mục không phù hợp với chiều tiền vào/ra.");
    }
    const amount = parseMoney(body.amount, "Số tiền");
    if (amount.isZero()) throw new HttpError(400, "Số tiền giao dịch phải lớn hơn 0.");
    const notes = optionalText(body.notes, "Ghi chú");

    return prisma.$transaction(async (tx) => {
      const lockedShift = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
          FROM "cash_shifts"
         WHERE "id" = ${shiftId}::uuid
           AND "business_id" = ${businessId}::uuid
           AND "status" = 'OPEN'
         FOR UPDATE
      `;
      if (!lockedShift.length) throw new HttpError(404, "Không tìm thấy ca đang mở.");

      if (transactionType === "OUT") {
        const shift = await tx.cashShift.findUniqueOrThrow({
          where: { id: shiftId },
          include: { cashTransactions: true },
        });
        const availableCash = calculateExpectedCash(shift.openingCash, shift.cashTransactions);
        if (amount.greaterThan(availableCash)) {
          throw new HttpError(400, "Số tiền chi vượt quá số dư tiền mặt đang có trong két theo các giao dịch đã ghi.");
        }
      }

      return tx.cashTransaction.create({
        data: {
          businessId,
          shiftId,
          transactionType,
          category,
          amount,
          notes,
          createdBy: userId,
        },
        include: { createdByUser: { select: { id: true, fullName: true } } },
      });
    });
  }

  async previewClose(
    businessId: string,
    userId: string,
    shiftId: string,
    actualCashInput: unknown,
  ) {
    const actualCash = parseMoney(actualCashInput, "Tiền kiểm đếm");
    const shift = await prisma.cashShift.findFirst({
      where: { id: shiftId, businessId, status: "OPEN" },
      include: { cashTransactions: true },
    });
    if (!shift) throw new HttpError(404, "Không tìm thấy ca đang mở.");
    if (shift.userId !== userId) {
      throw new HttpError(403, "Chỉ nhân viên chịu trách nhiệm ca mới được gửi kiểm đếm.");
    }
    const expectedCash = calculateExpectedCash(shift.openingCash, shift.cashTransactions);
    return {
      isMatched: actualCash.equals(expectedCash),
      requiresExplanation: !actualCash.equals(expectedCash),
    };
  }

  async closeShift(
    businessId: string,
    userId: string,
    shiftId: string,
    body: Record<string, unknown>,
    canReconcile: boolean,
  ) {
    const actualCash = parseMoney(body.actualCash, "Tiền kiểm đếm");
    const explanation = optionalText(body.explanation, "Lý do chênh lệch");

    return prisma.$transaction(async (tx) => {
      const lockedShift = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
          FROM "cash_shifts"
         WHERE "id" = ${shiftId}::uuid
           AND "business_id" = ${businessId}::uuid
           AND "status" = 'OPEN'
         FOR UPDATE
      `;
      if (!lockedShift.length) throw new HttpError(404, "Không tìm thấy ca đang mở.");

      const shift = await tx.cashShift.findUniqueOrThrow({
        where: { id: shiftId },
        include: { cashTransactions: true },
      });
      if (shift.userId !== userId) {
        throw new HttpError(403, "Chỉ nhân viên chịu trách nhiệm mở ca này mới được kiểm đếm và đóng ca.");
      }

      const expectedCash = calculateExpectedCash(shift.openingCash, shift.cashTransactions);
      if (expectedCash.isNegative() || expectedCash.greaterThan(maximumAmount)) {
        throw new HttpError(409, "Số tiền dự kiến vượt giới hạn lưu trữ; vui lòng kiểm tra các giao dịch.");
      }
      const differenceCash = actualCash.minus(expectedCash);
      if (!differenceCash.isZero() && !explanation) {
        throw new HttpError(400, "Có chênh lệch. Vui lòng nhập lý do trước khi gửi yêu cầu kết thúc ca.");
      }
      const submittedAt = new Date();
      const [closedShift, review] = await Promise.all([
        tx.cashShift.update({
          where: { id: shiftId },
          data: {
            actualCash,
            closedAt: submittedAt,
            shiftNotes: explanation,
            status: "CLOSED",
            expectedCash,
            differenceCash,
            reconciliationStatus: "INCOMPLETE_DATA",
          },
        }),
        tx.cashShiftCloseReview.create({
          data: {
            businessId,
            shiftId,
            revision: 1,
            expectedCash,
            actualCash,
            differenceCash,
            isMatched: differenceCash.isZero(),
            explanation,
            submittedBy: userId,
            submittedAt,
          },
        }),
      ]);

      return {
        shift: presentShift(closedShift, canReconcile),
        review: {
          id: review.id,
          status: review.status,
          isMatched: review.isMatched,
          ...(canReconcile
            ? {
                expectedCash: review.expectedCash.toFixed(2),
                actualCash: review.actualCash.toFixed(2),
                differenceCash: review.differenceCash.toFixed(2),
              }
            : {}),
        },
      };
    });
  }

  async resubmitCloseExplanation(
    businessId: string,
    userId: string,
    shiftId: string,
    body: Record<string, unknown>,
    canReconcile: boolean,
  ) {
    const explanation = requireText(body.explanation, "Lý do chênh lệch");
    const requestedActualCash = body.actualCash === undefined
      ? null
      : parseMoney(body.actualCash, "Tiền kiểm đếm");

    return prisma.$transaction(async (tx) => {
      const shift = await tx.cashShift.findFirst({
        where: { id: shiftId, businessId, status: "CLOSED", userId },
        include: {
          cashTransactions: true,
          closeReviews: { orderBy: { revision: "desc" }, take: 1 },
        },
      });
      if (!shift) throw new HttpError(404, "Không tìm thấy ca cần giải trình.");
      const previousReview = shift.closeReviews[0];
      if (!previousReview || previousReview.status !== "NEEDS_EXPLANATION") {
        throw new HttpError(409, "Ca này hiện không chờ giải trình.");
      }

      const actualCash = requestedActualCash ?? previousReview.actualCash;
      const expectedCash = calculateExpectedCash(shift.openingCash, shift.cashTransactions);
      if (expectedCash.isNegative() || expectedCash.greaterThan(maximumAmount)) {
        throw new HttpError(409, "Số tiền dự kiến vượt giới hạn lưu trữ; vui lòng kiểm tra các giao dịch.");
      }
      const differenceCash = actualCash.minus(expectedCash);
      const revision = previousReview.revision + 1;
      const [review] = await Promise.all([
        tx.cashShiftCloseReview.create({
          data: {
            businessId,
            shiftId,
            revision,
            expectedCash,
            actualCash,
            differenceCash,
            isMatched: differenceCash.isZero(),
            explanation,
            submittedBy: userId,
          },
        }),
        tx.cashShift.update({
          where: { id: shiftId },
          data: {
            actualCash,
            expectedCash,
            differenceCash,
            shiftNotes: explanation,
            reconciliationStatus: "INCOMPLETE_DATA",
          },
        }),
      ]);

      return {
        id: review.id,
        status: review.status,
        isMatched: review.isMatched,
        ...(canReconcile
          ? {
              expectedCash: review.expectedCash.toFixed(2),
              actualCash: review.actualCash.toFixed(2),
              differenceCash: review.differenceCash.toFixed(2),
            }
          : {}),
      };
    });
  }

  async resubmitHandoffExplanation(
    businessId: string,
    userId: string,
    handoffId: string,
    explanationInput: unknown,
  ) {
    const explanation = requireText(explanationInput, "Lý do chênh lệch bàn giao");
    return prisma.$transaction(async (tx) => {
      const handoff = await tx.cashShiftHandoff.findFirst({
        where: {
          id: handoffId,
          businessId,
          status: "NEEDS_EXPLANATION",
          nextShift: { userId },
        },
        include: { reviewRecords: { orderBy: { revision: "desc" }, take: 1 } },
      });
      if (!handoff) throw new HttpError(404, "Không tìm thấy bàn giao đang chờ giải trình.");
      const previousReview = handoff.reviewRecords[0];
      if (!previousReview || previousReview.status !== "NEEDS_EXPLANATION") {
        throw new HttpError(409, "Bàn giao này hiện không chờ giải trình.");
      }
      const revision = previousReview.revision + 1;
      await Promise.all([
        tx.cashShiftHandoffReview.create({
          data: {
            businessId,
            handoffId,
            revision,
            explanation,
            submittedBy: userId,
          },
        }),
        tx.cashShiftHandoff.update({
          where: { id: handoffId },
          data: {
            status: "PENDING_REVIEW",
            explanation,
            reviewedBy: null,
            reviewedAt: null,
            reviewerNote: null,
          },
        }),
      ]);
      return { id: handoff.id, status: "PENDING_REVIEW" as const };
    });
  }

  async recordWithdrawal(
    businessId: string,
    userId: string,
    shiftId: string,
    body: Record<string, unknown>,
  ) {
    const amount = parseMoney(body.amount, "Số tiền rút");
    if (amount.isZero()) throw new HttpError(400, "Số tiền rút phải lớn hơn 0.");
    const purpose = requireText(body.purpose, "Mục đích rút tiền");
    const destination = requireText(body.destination, "Nơi nhận tiền");
    if (destination.length > 255) throw new HttpError(400, "Nơi nhận tiền không được vượt quá 255 ký tự.");

    return prisma.$transaction(async (tx) => {
      const lockedShift = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
          FROM "cash_shifts"
         WHERE "id" = ${shiftId}::uuid
           AND "business_id" = ${businessId}::uuid
           AND "status" = 'OPEN'
         FOR UPDATE
      `;
      if (!lockedShift.length) throw new HttpError(404, "Không tìm thấy ca đang mở.");
      const shift = await tx.cashShift.findUniqueOrThrow({
        where: { id: shiftId },
        include: { cashTransactions: true },
      });
      const availableCash = calculateExpectedCash(shift.openingCash, shift.cashTransactions);
      if (amount.greaterThan(availableCash)) {
        throw new HttpError(400, "Số tiền rút vượt quá số dư tiền mặt đang có trong két theo các giao dịch đã ghi.");
      }

      return tx.cashTransaction.create({
        data: {
          businessId,
          shiftId,
          transactionType: "OUT",
          category: "SAFE_DROP",
          amount,
          recipientOrPayer: destination,
          notes: purpose,
          createdBy: userId,
        },
        include: { createdByUser: { select: { id: true, fullName: true } } },
      });
    });
  }

  async getReviewQueue(businessId: string) {
    const [closeReviews, handoffs] = await Promise.all([
      prisma.cashShiftCloseReview.findMany({
        where: { businessId, status: "PENDING_REVIEW" },
        orderBy: { submittedAt: "asc" },
        take: 50,
        include: {
          submittedByUser: { select: { id: true, fullName: true } },
          shift: { select: { id: true, openedAt: true, closedAt: true, userId: true } },
        },
      }),
      prisma.cashShiftHandoffReview.findMany({
        where: { businessId, status: "PENDING_REVIEW" },
        orderBy: { submittedAt: "asc" },
        take: 50,
        include: {
          submittedByUser: { select: { id: true, fullName: true } },
          handoff: {
            select: {
              id: true,
              handedOverCash: true,
              receivedCash: true,
              differenceCash: true,
              previousShiftId: true,
              nextShiftId: true,
              previousShift: { select: { user: { select: { fullName: true } } } },
              nextShift: { select: { user: { select: { fullName: true } } } },
            },
          },
        },
      }),
    ]);
    return { closeReviews, handoffs };
  }

  async decideCloseReview(
    businessId: string,
    reviewerId: string,
    reviewId: string,
    body: Record<string, unknown>,
  ) {
    const decision = body.decision;
    if (decision !== "APPROVE" && decision !== "REQUEST_EXPLANATION") {
      throw new HttpError(400, "Quyết định duyệt không hợp lệ.");
    }
    const reviewerNote = decision === "REQUEST_EXPLANATION"
      ? requireText(body.reviewerNote, "Lý do yêu cầu giải trình")
      : optionalText(body.reviewerNote, "Ghi chú duyệt");

    return prisma.$transaction(async (tx) => {
      const review = await tx.cashShiftCloseReview.findFirst({
        where: { id: reviewId, businessId, status: "PENDING_REVIEW" },
        include: { shift: { select: { userId: true } } },
      });
      if (!review) throw new HttpError(404, "Không tìm thấy yêu cầu kiểm kê đang chờ duyệt.");
      if (review.submittedBy === reviewerId || review.shift.userId === reviewerId) {
        throw new HttpError(403, "Người chịu trách nhiệm ca không được tự duyệt yêu cầu của mình.");
      }
      const status = decision === "APPROVE" ? "APPROVED" : "NEEDS_EXPLANATION";
      const updateResult = await tx.cashShiftCloseReview.updateMany({
        where: { id: reviewId, businessId, status: "PENDING_REVIEW" },
        data: { status, reviewedBy: reviewerId, reviewedAt: new Date(), reviewerNote },
      });
      if (updateResult.count !== 1) throw new HttpError(409, "Yêu cầu này đã được một người khác xử lý.");
      await tx.cashShift.update({
        where: { id: review.shiftId },
        data: { reconciliationStatus: "INCOMPLETE_DATA" },
      });
      return tx.cashShiftCloseReview.findUniqueOrThrow({ where: { id: reviewId } });
    });
  }

  async decideHandoffReview(
    businessId: string,
    reviewerId: string,
    reviewId: string,
    body: Record<string, unknown>,
  ) {
    const decision = body.decision;
    if (decision !== "APPROVE" && decision !== "REQUEST_EXPLANATION") {
      throw new HttpError(400, "Quyết định duyệt bàn giao không hợp lệ.");
    }
    const reviewerNote = decision === "REQUEST_EXPLANATION"
      ? requireText(body.reviewerNote, "Lý do yêu cầu giải trình")
      : optionalText(body.reviewerNote, "Ghi chú duyệt");

    return prisma.$transaction(async (tx) => {
      const review = await tx.cashShiftHandoffReview.findFirst({
        where: { id: reviewId, businessId, status: "PENDING_REVIEW" },
        include: { handoff: { select: { recordedBy: true, id: true } } },
      });
      if (!review) throw new HttpError(404, "Không tìm thấy yêu cầu bàn giao đang chờ duyệt.");
      if (review.submittedBy === reviewerId || review.handoff.recordedBy === reviewerId) {
        throw new HttpError(403, "Người ghi nhận bàn giao không được tự duyệt yêu cầu của mình.");
      }
      const status = decision === "APPROVE" ? "APPROVED" : "NEEDS_EXPLANATION";
      const reviewedAt = new Date();
      const updatedReview = await tx.cashShiftHandoffReview.updateMany({
        where: { id: reviewId, businessId, status: "PENDING_REVIEW" },
        data: { status, reviewedBy: reviewerId, reviewedAt, reviewerNote },
      });
      if (updatedReview.count !== 1) throw new HttpError(409, "Yêu cầu bàn giao này đã được một người khác xử lý.");
      const updatedHandoff = await tx.cashShiftHandoff.updateMany({
        where: { id: review.handoff.id, businessId, status: "PENDING_REVIEW" },
        data: { status, reviewedBy: reviewerId, reviewedAt, reviewerNote },
      });
      if (updatedHandoff.count !== 1) throw new HttpError(409, "Bàn giao này đã được một người khác xử lý.");
      return tx.cashShiftHandoffReview.findUniqueOrThrow({ where: { id: reviewId } });
    });
  }
}
