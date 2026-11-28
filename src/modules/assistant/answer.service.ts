import { Prisma } from "@prisma/client";

import { getBusinessMovement } from "../business-data/business-movement.service";
import { dateRange, metricDate, vietnamToday } from "../../shared/dates/date-range";
import { HttpError } from "../../shared/http/http-error";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isComparisonMetric(value: unknown): value is "netRevenue" | "grossProfit" {
  return value === "netRevenue" || value === "grossProfit";
}

function previousComparison(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.source !== "POS" || data.type === "comparison_breakdown_v1" || !isComparisonMetric(data.metric) ||
      !data.ranges || typeof data.ranges !== "object" || Array.isArray(data.ranges) ||
      !("subject" in data)) return null;
  const ranges = data.ranges as Record<string, unknown>;
  if (!ranges.current || typeof ranges.current !== "object" || Array.isArray(ranges.current) ||
      !ranges.previous || typeof ranges.previous !== "object" || Array.isArray(ranges.previous)) return null;
  const current = ranges.current as Record<string, unknown>;
  const previous = ranges.previous as Record<string, unknown>;
  let currentRange;
  let previousRange;
  try {
    currentRange = dateRange(current.from, current.to);
    previousRange = dateRange(previous.from, previous.to);
  } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
  if (currentRange.dayCount > 183 || currentRange.to > vietnamToday() ||
      previousRange.dayCount !== currentRange.dayCount ||
      metricDate(currentRange.from).getTime() - metricDate(previousRange.to).getTime() !== 86_400_000 ||
      (current.dayCount !== undefined && current.dayCount !== currentRange.dayCount) ||
      (previous.dayCount !== undefined && previous.dayCount !== previousRange.dayCount)) return null;
  if (data.subject === null) return { from: currentRange.from, to: currentRange.to, metric: data.metric };
  if (!data.subject || typeof data.subject !== "object" || Array.isArray(data.subject)) return null;
  const subject = data.subject as Record<string, unknown>;
  if (typeof subject.productId !== "string" || !uuid.test(subject.productId) ||
      typeof subject.product !== "string" || !subject.product.trim()) return null;
  if (subject.variantId !== undefined || subject.sku !== undefined) {
    if (typeof subject.variantId !== "string" || !uuid.test(subject.variantId) ||
        typeof subject.sku !== "string" || !subject.sku.trim()) return null;
    return { from: currentRange.from, to: currentRange.to, metric: data.metric, productId: subject.productId, variantId: subject.variantId };
  }
  return { from: currentRange.from, to: currentRange.to, metric: data.metric, productId: subject.productId };
}

export function hasPreviousComparison(value: unknown) {
  return previousComparison(value) !== null;
}

export async function answerComparisonMetricChange(businessId: string, question: string, metric: unknown, previous: unknown) {
  if (!isComparisonMetric(metric)) throw new HttpError(400, "Chỉ số hỏi tiếp không được hỗ trợ.");
  const context = previousComparison(previous);
  if (!context) throw new HttpError(400, "Hãy xem lại một câu so sánh doanh thu hoặc lợi nhuận gộp trước khi hỏi tiếp.");
  return answerMovement(businessId, { question, ...context, metric });
}

export function isComparisonBreakdownLevel(value: unknown): value is "product" | "sku" {
  return value === "product" || value === "sku";
}

export function hasComparisonBreakdown(value: unknown, level: unknown) {
  const context = previousComparison(value);
  return !!context && (level === "product" ? !context.productId : level === "sku" && !!context.productId && !context.variantId);
}

export async function answerComparisonBreakdown(businessId: string, question: string, level: unknown, previous: unknown) {
  if (!isComparisonBreakdownLevel(level)) throw new HttpError(400, "Cấp chi tiết không được hỗ trợ.");
  const context = previousComparison(previous);
  if (!context || !hasComparisonBreakdown(previous, level)) {
    throw new HttpError(400, "Hãy xem so sánh toàn cửa hàng trước khi xem theo sản phẩm, hoặc so sánh một sản phẩm trước khi xem theo mã hàng.");
  }
  const snapshot = await getBusinessMovement(businessId, { from: context.from, to: context.to });
  const product = context.productId ? snapshot.items.find((item) => item.id === context.productId) : undefined;
  if (context.productId && !product) throw new HttpError(404, "Không tìm thấy sản phẩm có phát sinh trong kỳ.");
  const metric = context.metric;
  const entries = level === "product"
    ? snapshot.items.map((item) => ({ id: item.id, name: item.name, comparison: item }))
    : product!.variants.map((item) => ({ id: item.id, name: item.sku, comparison: item }));
  entries.sort((a, b) => new Prisma.Decimal(b.comparison.current[metric]).comparedTo(a.comparison.current[metric]) ||
    a.name.localeCompare(b.name, "vi") || a.id.localeCompare(b.id));
  const items = entries.slice(0, 20).map(({ id, name, comparison }) => ({
    id, name, current: comparison.current[metric], previous: comparison.previous[metric],
    difference: comparison.changes[metric].difference, percent: comparison.changes[metric].percent,
  }));
  const label = metric === "netRevenue" ? "doanh thu thuần" : "lợi nhuận gộp";
  const snapshotDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(snapshot.asOf);
  const warnings = snapshot.warnings;
  const hasWarnings = warnings.excludedSaleItems > 0 || warnings.excludedReturnItems > 0 || warnings.missingReturnCostLinks > 0;
  const text = `Chi tiết ${label} theo ${level === "product" ? "sản phẩm" : "mã hàng"} trong hai kỳ đã xem: ${entries.length} mục có phát sinh, hiển thị ${items.length} mục theo kết quả kỳ này giảm dần.${entries.length > items.length ? " Danh sách chưa hiển thị hết; xem trang Hiệu quả sản phẩm để tra cứu thêm." : ""}${metric === "grossProfit" ? " Lợi nhuận gộp chưa trừ chi phí vận hành và không phải lợi nhuận ròng." : ""}${snapshot.ranges.current.to >= snapshotDay ? " Kỳ này chưa kết thúc tại thời điểm đọc nên số liệu chưa đầy đủ." : ""}${hasWarnings ? " Có cảnh báo dữ liệu có thể ảnh hưởng kết quả; hãy xem căn cứ." : ""} Số liệu được đọc lại và có thể khác câu trả lời trước; chênh lệch không cho biết nguyên nhân.`;
  return { question: question.trim(), text, evidence: {
    type: "comparison_breakdown_v1" as const, source: "POS" as const, level, metric,
    subject: product ? { product: product.name, productId: product.id } : null,
    ranges: snapshot.ranges, asOf: snapshot.asOf.toISOString(), warnings: snapshot.warnings,
    total: entries.length, items,
  } };
}

export async function answerMovement(businessId: string, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Yêu cầu không hợp lệ.");
  const body = input as Record<string, unknown>;
  if (typeof body.question !== "string" || !body.question.trim() || body.question.trim().length > 500 ||
      (body.metric !== "netRevenue" && body.metric !== "grossProfit") ||
      typeof body.from !== "string" || typeof body.to !== "string" ||
      (body.productId !== undefined && (typeof body.productId !== "string" || !uuid.test(body.productId))) ||
      (body.variantId !== undefined && (typeof body.variantId !== "string" || !uuid.test(body.variantId) || !body.productId)) ||
      (body.subjectType !== undefined && body.subjectType !== "store" && body.subjectType !== "product" && body.subjectType !== "sku") ||
      (body.subjectType === "store" && body.subject !== undefined) ||
      (body.subjectType === undefined && body.subject !== undefined) ||
      ((body.subjectType === "product" || body.subjectType === "sku") &&
        (typeof body.subject !== "string" || !body.subject.trim() || body.subject.length > 200)) ||
      (body.subjectType !== undefined && (body.productId !== undefined || body.variantId !== undefined))) {
    throw new HttpError(400, "Câu hỏi hoặc các lựa chọn phân tích không hợp lệ.");
  }
  const snapshot = await getBusinessMovement(businessId, { from: body.from, to: body.to });
  const normalize = (value: string) => value.trim().toLocaleLowerCase("vi");
  let product = body.productId ? snapshot.items.find((item) => item.id === body.productId) : undefined;
  let variant = body.variantId ? product?.variants.find((item) => item.id === body.variantId) : undefined;
  if ((body.subjectType === "product" || body.subjectType === "sku") && typeof body.subject === "string") {
    const subject = normalize(body.subject);
    if (body.subjectType === "product") {
      const matches = snapshot.items.filter((item) => normalize(item.name) === subject);
      if (matches.length > 1) throw new HttpError(409, "Có nhiều sản phẩm trùng tên. Hãy hỏi lại với mã hàng cụ thể.");
      if (!matches.length) throw new HttpError(404, "Không tìm thấy sản phẩm trùng tên có phát sinh trong hai kỳ. Hãy kiểm tra tên và hỏi lại.");
      product = matches[0];
    } else {
      const matches = snapshot.items.flatMap((item) => item.variants
        .filter((entry) => normalize(entry.sku) === subject).map((entry) => ({ product: item, variant: entry })));
      if (matches.length > 1) throw new HttpError(409, "Có nhiều mã hàng trùng nhau. Hãy kiểm tra lại mã hàng.");
      if (!matches.length) throw new HttpError(404, "Không tìm thấy mã hàng trùng khớp có phát sinh trong hai kỳ. Hãy kiểm tra mã và hỏi lại.");
      product = matches[0].product; variant = matches[0].variant;
    }
  }
  if (body.productId && !product) throw new HttpError(404, "Không tìm thấy sản phẩm có phát sinh trong kỳ.");
  if (body.variantId && !variant) throw new HttpError(404, "Không tìm thấy mã hàng có phát sinh trong kỳ.");
  const comparison = variant ?? product ?? snapshot.totals;
  const metric = body.metric;
  const label = metric === "netRevenue" ? "Doanh thu thuần" : "Lợi nhuận gộp";
  const change = comparison.changes[metric].difference;
  const direction = new Prisma.Decimal(change).comparedTo(0);
  const snapshotDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(snapshot.asOf);
  const incomplete = snapshot.ranges.current.to >= snapshotDay;
  const warnings = snapshot.warnings;
  const hasWarnings = warnings.excludedSaleItems > 0 || warnings.excludedReturnItems > 0 || warnings.missingReturnCostLinks > 0;
  const text = `${label} kỳ này là ${comparison.current[metric]} đồng, kỳ trước là ${comparison.previous[metric]} đồng; ${direction > 0 ? "tăng" : direction < 0 ? "giảm" : "không đổi"}${direction === 0 ? "" : ` ${new Prisma.Decimal(change).abs().toFixed(2)} đồng`}. Đây là chênh lệch ghi nhận, không khẳng định nguyên nhân kinh doanh.${metric === "grossProfit" ? " Lợi nhuận gộp chưa trừ chi phí vận hành và không phải lợi nhuận ròng." : ""}${incomplete ? " Kỳ này chưa kết thúc tại thời điểm đọc nên số liệu chưa đầy đủ." : ""}${hasWarnings ? " Có cảnh báo dữ liệu có thể ảnh hưởng kết quả; hãy xem căn cứ." : ""}`;
  const evidence = {
    source: "POS",
    ranges: snapshot.ranges,
    asOf: snapshot.asOf.toISOString(),
    metric,
    subject: variant ? { product: product!.name, productId: product!.id, sku: variant.sku, variantId: variant.id }
      : product ? { product: product.name, productId: product.id } : null,
    current: comparison.current[metric],
    previous: comparison.previous[metric],
    difference: change,
    percent: comparison.changes[metric].percent,
    warnings: snapshot.warnings,
  };
  return { question: body.question.trim(), text, evidence };
}
