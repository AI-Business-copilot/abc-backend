import { Router } from "express";

import { requireBusinessScope } from "../../shared/auth/business-scope.middleware";
import { requirePermission } from "../../shared/auth/require-permission.middleware";
import { requireSupabaseIdentity } from "../../shared/auth/supabase-auth.middleware";
import { HttpError } from "../../shared/http/http-error";
import { prisma } from "../../shared/infrastructure/database/prisma.client";
import { answerComparisonBreakdown, answerComparisonMetricChange, answerMovement, hasComparisonBreakdown, hasPreviousComparison, isComparisonBreakdownLevel, isComparisonMetric } from "./answer.service";
import { interpretQuestion, isQuestionKind, validQuestion } from "./question.service";
import { answerSkuQuestion, hasRanking } from "./sku-analysis.service";
import { answerSlowExpiry } from "./slow-expiry.service";
import { answerProfitRestock } from "./profit-restock.service";
import { answerOverstockForecast } from "./overstock-forecast.service";
import { answerPreviousOverstock, answerPreviousRestock, hasPreviousSkuList } from "./previous-restock.service";
import { answerPreviousNearExpiry } from "./previous-near-expiry.service";
import { answerTopSellerInventory } from "./top-seller-inventory.service";
import { answerSkuComparison, hasComparableRanking } from "./sku-comparison.service";
import { answerPreviousItemCover, isPreviousItemPosition, positionInQuestion } from "./previous-item-cover.service";
import { answerPreviousActions, hasPreviousActions } from "./previous-actions.service";
import { answerComposableSkuQuestion, answerSkuPeriodChange, hasPreviousSkuQuery, isComposableSkuKind, isSkuPeriodChange, isSupportedSkuComposition, useComposableSkuQueries } from "./sku-query.service";

const router = Router();
router.use(requireSupabaseIdentity, requireBusinessScope);

function scope(locals: Record<string, unknown>) {
  return { businessId: String(locals.businessId), userId: String(locals.userId) };
}

function conversationId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, "Mã cuộc trò chuyện không hợp lệ.");
  }
  return value;
}

async function getConversationContext(owner: { businessId: string; userId: string }, id: string, permissions: string[]) {
  const existing = await prisma.assistantConversation.findFirst({
    where: { ...owner, id },
    select: { messages: {
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, requiredPermissions: true, role: true, evidence: true },
    } },
  });
  if (!existing) throw new HttpError(404, "Không tìm thấy cuộc trò chuyện.");
  if (existing.messages.some((message) => message.requiredPermissions.some((permission) => !permissions.includes(permission)))) {
    throw new HttpError(403, "Bạn không còn đủ quyền để xem cuộc trò chuyện này.");
  }
  return existing.messages.find((message) => message.role === "assistant");
}

async function requireOpenAiConsent(businessId: string) {
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: businessId }, select: { assistantOpenaiEnabled: true },
  });
  if (!business.assistantOpenaiEnabled) throw new HttpError(403, "Chủ cửa hàng chưa cho phép gửi câu hỏi tới OpenAI.");
}

router.get("/openai-consent", async (_req, res) => {
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: String(res.locals.businessId) },
    select: { assistantOpenaiEnabled: true },
  });
  res.json({ enabled: business.assistantOpenaiEnabled });
});

router.put("/openai-consent", async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") throw new HttpError(400, "Lựa chọn đồng ý không hợp lệ.");
  const { businessId, userId } = scope(res.locals);
  const membership = await prisma.businessMembership.findFirst({
    where: { businessId, userId, status: "ACTIVE", role: { code: "OWNER" } },
    select: { id: true },
  });
  if (!membership) throw new HttpError(403, "Chỉ chủ cửa hàng mới được thay đổi lựa chọn này.");
  const business = await prisma.business.update({
    where: { id: businessId }, data: { assistantOpenaiEnabled: req.body.enabled },
    select: { assistantOpenaiEnabled: true },
  });
  res.json({ enabled: business.assistantOpenaiEnabled });
});

router.post("/interpret", requirePermission("analytics.read"), requirePermission("finance.read"), async (req, res) => {
  const owner = scope(res.locals);
  const permissions = res.locals.permissionCodes as string[];
  const previous = req.body?.conversationId === undefined ? undefined
    : await getConversationContext(owner, conversationId(req.body.conversationId), permissions);
  await requireOpenAiConsent(owner.businessId);
  const interpretation = await interpretQuestion(req.body?.question, hasRanking(previous?.evidence));
  const hasPreviousRanking = hasRanking(previous?.evidence);
  const hasPreviousList = hasPreviousSkuList(previous?.evidence);
  const hasPreviousQuery = interpretation.kind === "change_sku_period" && hasPreviousSkuQuery(previous?.evidence);
  const hasComparison = interpretation.kind === "change_comparison_metric" && hasPreviousComparison(previous?.evidence);
  const hasBreakdown = interpretation.kind === "comparison_breakdown" && hasComparisonBreakdown(previous?.evidence, interpretation.level);
  const hasSalesComparison = interpretation.kind === "compare_previous_sku_sales" && hasComparableRanking(previous?.evidence);
  const hasActions = interpretation.kind === "previous_actions" && hasPreviousActions(previous?.evidence);
  res.json({ ...interpretation, hasPreviousRanking, hasPreviousSkuList: hasPreviousList,
    ...(interpretation.kind === "change_sku_period" ? { hasPreviousSkuQuery: hasPreviousQuery } : {}),
    ...(interpretation.kind === "change_comparison_metric" ? { hasPreviousComparison: hasComparison } : {}),
    ...(interpretation.kind === "comparison_breakdown" ? { hasPreviousComparisonBreakdown: hasBreakdown } : {}),
    ...(interpretation.kind === "compare_previous_sku_sales" ? { hasComparableRanking: hasSalesComparison } : {}),
    ...(interpretation.kind === "previous_actions" ? { hasPreviousActions: hasActions } : {}),
    ...((hasPreviousRanking || hasPreviousList || hasPreviousQuery || hasComparison || hasBreakdown || hasSalesComparison || hasActions) ? { previousMessageId: previous?.id } : {}) });
});

router.post("/conversations", requirePermission("analytics.read"), async (_req, res) => {
  const result = await prisma.assistantConversation.create({
    data: scope(res.locals),
    select: { id: true, createdAt: true, updatedAt: true },
  });
  res.status(201).json(result);
});

router.get("/conversations", async (req, res) => {
  const rawPage = req.query.page === undefined ? "1" : req.query.page;
  if (typeof rawPage !== "string" || !/^[1-9]\d{0,4}$/.test(rawPage)) {
    throw new HttpError(400, "Trang không hợp lệ.");
  }
  const page = Number(rawPage);
  const items = await prisma.assistantConversation.findMany({
    where: scope(res.locals),
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * 50,
    take: 51,
    select: { id: true, createdAt: true, updatedAt: true },
  });
  res.json({ items: items.slice(0, 50), page, hasMore: items.length > 50 });
});

router.get("/conversations/:id", requirePermission("analytics.read"), async (req, res) => {
  const conversation = await prisma.assistantConversation.findFirst({
    where: { ...scope(res.locals), id: conversationId(req.params.id) },
    select: {
      id: true, createdAt: true, updatedAt: true,
      messages: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, role: true, content: true, evidence: true, createdAt: true, requiredPermissions: true },
      },
    },
  });
  if (!conversation) throw new HttpError(404, "Không tìm thấy cuộc trò chuyện.");
  const permissions = res.locals.permissionCodes as string[];
  if (conversation.messages.some((message) => message.requiredPermissions.some((permission) => !permissions.includes(permission)))) {
    throw new HttpError(403, "Bạn không còn đủ quyền để xem cuộc trò chuyện này.");
  }
  res.json(conversation);
});

router.post("/conversations/:id/messages", requirePermission("analytics.read"), requirePermission("finance.read"), async (req, res) => {
  const id = conversationId(req.params.id);
  const owner = scope(res.locals);
  const permissions = res.locals.permissionCodes as string[];
  const previous = await getConversationContext(owner, id, permissions);
  await requireOpenAiConsent(owner.businessId);
  let answer;
  if (req.body?.analysis !== undefined) {
    if (!validQuestion(req.body.question) || !isQuestionKind(req.body.analysis) || req.body.analysis === "unsupported") {
      throw new HttpError(400, "Câu hỏi hoặc lựa chọn phân tích không hợp lệ.");
    }
    if (req.body.analysis === "top_sellers_composed" && !isSupportedSkuComposition(req.body.filters)) {
      throw new HttpError(400, "Các điều kiện kết hợp chưa được hỗ trợ.");
    }
    if (req.body.analysis === "top_sellers_composed" && !useComposableSkuQueries()) {
      throw new HttpError(503, "Câu hỏi kết hợp này hiện chưa khả dụng.");
    }
    if (req.body.analysis === "top_sellers_restock" && !useComposableSkuQueries()) {
      throw new HttpError(503, "Câu hỏi kết hợp này hiện chưa khả dụng.");
    }
    if (req.body.analysis === "change_sku_period" && !isSkuPeriodChange(req.body.periodChange)) {
      throw new HttpError(400, "Khoảng thời gian hỏi tiếp không được hỗ trợ.");
    }
    if (req.body.analysis === "change_sku_period" && !useComposableSkuQueries()) {
      throw new HttpError(503, "Câu hỏi đổi kỳ hiện chưa khả dụng.");
    }
    if (req.body.analysis === "change_comparison_metric" && !isComparisonMetric(req.body.metric)) {
      throw new HttpError(400, "Chỉ số hỏi tiếp không được hỗ trợ.");
    }
    if (req.body.analysis === "comparison_breakdown" && !isComparisonBreakdownLevel(req.body.level)) {
      throw new HttpError(400, "Cấp chi tiết không được hỗ trợ.");
    }
    if (req.body.analysis === "compare_previous_sku_sales" && !useComposableSkuQueries()) {
      throw new HttpError(503, "Câu hỏi so sánh số bán hiện chưa khả dụng.");
    }
    if (req.body.analysis === "previous_item_cover" && (!isPreviousItemPosition(req.body.position) || !positionInQuestion(req.body.question, req.body.position))) {
      throw new HttpError(400, "Hãy ghi rõ một vị trí trong danh sách, ví dụ mã đầu tiên hoặc mã thứ 2.");
    }
    if (req.body.analysis === "previous_stockout" || req.body.analysis === "previous_restock" || req.body.analysis === "previous_overstock" || req.body.analysis === "previous_near_expiry" || req.body.analysis === "change_sku_period" || req.body.analysis === "change_comparison_metric" || req.body.analysis === "comparison_breakdown" || req.body.analysis === "compare_previous_sku_sales" || req.body.analysis === "previous_item_cover" || req.body.analysis === "previous_actions") {
      if (typeof req.body.previousMessageId !== "string" || !req.body.previousMessageId) {
        throw new HttpError(400, "Hãy xem lại danh sách mã hàng trước khi hỏi tiếp.");
      }
      if (req.body.previousMessageId !== previous?.id) {
        throw new HttpError(409, "Cuộc trò chuyện đã thay đổi. Hãy tải lại trang và xem lại danh sách trước khi hỏi tiếp.");
      }
    }
    if (req.body.analysis === "previous_actions") {
      const result = answerPreviousActions(previous?.evidence);
      answer = { question: req.body.question.trim(), ...result, evidence: { ...result.evidence,
        followUp: { operation: "previous_actions", previousMessageId: previous?.id } } };
    } else if (req.body.analysis === "previous_item_cover") {
      const result = await answerPreviousItemCover(owner.businessId, previous?.evidence, req.body.position);
      answer = { question: req.body.question.trim(), ...result, evidence: { ...result.evidence,
        followUp: { operation: "previous_item_cover", previousMessageId: previous?.id } } };
    } else if (req.body.analysis === "compare_previous_sku_sales") {
      const result = await answerSkuComparison(owner.businessId, previous?.evidence);
      answer = { question: req.body.question.trim(), ...result, evidence: { ...result.evidence,
        followUp: { operation: "compare_previous_sku_sales", previousMessageId: previous?.id } } };
    } else if (req.body.analysis === "comparison_breakdown") {
      const result = await answerComparisonBreakdown(owner.businessId, req.body.question, req.body.level, previous?.evidence);
      answer = { ...result, evidence: { ...result.evidence, followUp: {
        operation: "comparison_breakdown", previousMessageId: previous?.id,
      } } };
    } else if (req.body.analysis === "change_comparison_metric") {
      const result = await answerComparisonMetricChange(owner.businessId, req.body.question, req.body.metric, previous?.evidence);
      answer = { ...result, evidence: { ...result.evidence, followUp: {
        operation: "change_comparison_metric", previousMessageId: previous?.id,
      } } };
    } else if (req.body.analysis === "change_sku_period") {
      const result = await answerSkuPeriodChange(owner.businessId, previous?.evidence, req.body.periodChange);
      answer = { question: req.body.question.trim(), text: result.text, evidence: {
        ...result.evidence, analysis: result.kind, followUp: { operation: "change_period", periodChange: req.body.periodChange, previousMessageId: previous?.id },
      } };
    } else {
      const result = isComposableSkuKind(req.body.analysis) && useComposableSkuQueries()
        ? await answerComposableSkuQuestion(owner.businessId, req.body.analysis, req.body.filters)
        : req.body.analysis === "slow_moving_expiry"
        ? await answerSlowExpiry(owner.businessId)
        : req.body.analysis === "top_sellers_overstock" || req.body.analysis === "top_sellers_near_expiry"
        ? await answerTopSellerInventory(owner.businessId, req.body.analysis)
        : req.body.analysis === "previous_restock"
        ? await answerPreviousRestock(owner.businessId, previous?.evidence)
        : req.body.analysis === "previous_overstock"
        ? await answerPreviousOverstock(owner.businessId, previous?.evidence)
        : req.body.analysis === "previous_near_expiry"
        ? await answerPreviousNearExpiry(owner.businessId, previous?.evidence)
        : req.body.analysis === "overstock_forecast"
        ? await answerOverstockForecast(owner.businessId)
        : req.body.analysis === "profit_restock"
        ? await answerProfitRestock(owner.businessId)
        : await answerSkuQuestion(owner.businessId, req.body.analysis, previous?.evidence);
      answer = { question: req.body.question.trim(), ...result, evidence: { ...result.evidence, analysis: req.body.analysis } };
    }
  } else {
    answer = await answerMovement(owner.businessId, req.body);
  }
  const requiredPermissions = ["analytics.read", "finance.read"];
  const messages = await prisma.$transaction(async (tx) => {
    const updated = await tx.assistantConversation.updateMany({
      where: { ...owner, id },
      data: { updatedAt: new Date() },
    });
    if (!updated.count) throw new HttpError(404, "Không tìm thấy cuộc trò chuyện.");
    const priorMessages = await tx.assistantMessage.findMany({
      where: { conversationId: id }, select: { requiredPermissions: true },
    });
    if (priorMessages.some((message) => message.requiredPermissions.some((permission) => !permissions.includes(permission)))) {
      throw new HttpError(403, "Bạn không còn đủ quyền để xem cuộc trò chuyện này.");
    }
    if (req.body?.analysis === "previous_stockout" || req.body?.analysis === "previous_restock" || req.body?.analysis === "previous_overstock" || req.body?.analysis === "previous_near_expiry" || req.body?.analysis === "change_sku_period" || req.body?.analysis === "change_comparison_metric" || req.body?.analysis === "comparison_breakdown" || req.body?.analysis === "compare_previous_sku_sales" || req.body?.analysis === "previous_item_cover" || req.body?.analysis === "previous_actions") {
      const current = await tx.assistantMessage.findFirst({
        where: { conversationId: id, role: "assistant" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true },
      });
      if (current?.id !== previous?.id) throw new HttpError(409, "Cuộc trò chuyện đã thay đổi. Hãy tải lại trang và xem lại danh sách trước khi hỏi tiếp.");
    }
    const last = await tx.assistantMessage.findFirst({
      where: { conversationId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true },
    });
    const createdAt = new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1));
    const user = await tx.assistantMessage.create({
      data: { conversationId: id, role: "user", content: answer.question, requiredPermissions, createdAt },
    });
    const assistant = await tx.assistantMessage.create({
      data: { conversationId: id, role: "assistant", content: answer.text, evidence: answer.evidence, requiredPermissions, createdAt: new Date(createdAt.getTime() + 1) },
    });
    return [user, assistant];
  });
  res.status(201).json({ messages });
});

router.delete("/conversations/:id", async (req, res) => {
  const result = await prisma.assistantConversation.deleteMany({
    where: { ...scope(res.locals), id: conversationId(req.params.id) },
  });
  if (!result.count) throw new HttpError(404, "Không tìm thấy cuộc trò chuyện.");
  res.status(204).end();
});

export default router;
