import { dateRange, lastCompletedWeekRange, metricDate, vietnamToday } from "../../shared/dates/date-range";
import { HttpError } from "../../shared/http/http-error";

type Period = "today" | "yesterday" | "last_7_days" | "last_30_days" | "this_week" | "last_week" | "this_month" | "last_month" | "dates";
type SubjectType = "store" | "product" | "sku";
export type ComparisonRequest = {
  metric: "netRevenue" | "grossProfit";
  from: string;
  to: string;
  subjectType: SubjectType;
  subject?: string;
};

const periods: string[] = ["today", "yesterday", "last_7_days", "last_30_days", "this_week", "last_week", "this_month", "last_month", "dates"];
const clarificationMessages = {
  period: "Hãy hỏi lại và cho biết khoảng thời gian muốn xem, ví dụ 7 ngày gần nhất hoặc tuần này.",
  metric: "Hãy hỏi lại và cho biết muốn xem doanh thu thuần hay lợi nhuận gộp.",
  subject: "Hãy hỏi lại và ghi rõ tên sản phẩm hoặc mã hàng cần xem.",
  comparison: "Hãy hỏi lại và cho biết muốn so sánh với kỳ trước liền kề.",
} as const;
type Clarification = keyof typeof clarificationMessages;

function invalid(): never {
  throw new HttpError(502, "Dịch vụ AI trả cách hiểu câu hỏi không hợp lệ.");
}

function dateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function rangeFor(period: Period, from: unknown, to: unknown, question: string, now: Date) {
  const today = vietnamToday(now);
  if (period === "dates") {
    if (typeof from !== "string" || typeof to !== "string" || !question.includes(from) || !question.includes(to)) return invalid();
    const range = dateRange(from, to);
    if (range.dayCount > 183 || range.to > today) throw new HttpError(400, "Khoảng thời gian phải tối đa 183 ngày và không kết thúc trong tương lai.");
    return { from: range.from, to: range.to };
  }
  const end = metricDate(today);
  const start = new Date(end);
  if (period === "yesterday") { end.setUTCDate(end.getUTCDate() - 1); start.setTime(end.getTime()); }
  if (period === "last_7_days" || period === "last_30_days") {
    end.setUTCDate(end.getUTCDate() - 1);
    start.setTime(end.getTime());
    start.setUTCDate(start.getUTCDate() - (period === "last_7_days" ? 6 : 29));
  }
  if (period === "last_week") return lastCompletedWeekRange(now);
  if (period === "this_week") {
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  }
  if (period === "this_month" || period === "last_month") {
    start.setUTCDate(1);
    if (period === "last_month") {
      end.setTime(start.getTime()); end.setUTCDate(end.getUTCDate() - 1);
      start.setUTCMonth(start.getUTCMonth() - 1);
    }
  }
  return { from: dateString(start), to: dateString(end) };
}

export function parseComparison(value: Record<string, unknown>, question: string, now = new Date()):
  | { kind: "comparison"; comparison: ComparisonRequest }
  | { kind: "clarify_comparison"; clarification: string } {
  if (value.kind === "clarify_comparison") {
    if (Object.keys(value).length !== 2 || typeof value.missing !== "string" || !Object.prototype.hasOwnProperty.call(clarificationMessages, value.missing)) return invalid();
    return { kind: "clarify_comparison", clarification: clarificationMessages[value.missing as Clarification] };
  }
  const allowed = ["kind", "metric", "period", "subjectType", "subject", "from", "to"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) ||
      (value.metric !== "netRevenue" && value.metric !== "grossProfit") ||
      typeof value.period !== "string" || !periods.includes(value.period) ||
      (value.subjectType !== "store" && value.subjectType !== "product" && value.subjectType !== "sku")) return invalid();
  const period = value.period as Period;
  if (period !== "dates" && (value.from !== undefined || value.to !== undefined)) return invalid();
  if (value.subjectType === "store" && value.subject !== undefined) return invalid();
  if (value.subjectType !== "store" && (typeof value.subject !== "string" || !value.subject.trim() ||
      value.subject.length > 200 || !question.toLocaleLowerCase("vi").includes(value.subject.trim().toLocaleLowerCase("vi")))) return invalid();
  return {
    kind: "comparison",
    comparison: {
      metric: value.metric,
      ...rangeFor(period, value.from, value.to, question, now),
      subjectType: value.subjectType,
      ...(typeof value.subject === "string" ? { subject: value.subject.trim() } : {}),
    },
  };
}
