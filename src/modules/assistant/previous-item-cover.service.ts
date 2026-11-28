import { HttpError } from "../../shared/http/http-error";
import { inventoryOutlook } from "../ai-insights/inventory-outlook.service";
import { previousList } from "./previous-restock.service";

const words: Record<string, number> = { nhất: 1, hai: 2, ba: 3, tư: 4, bốn: 4, năm: 5, sáu: 6, bảy: 7, tám: 8, chín: 9, mười: 10 };

export function isPreviousItemPosition(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10;
}

export function positionInQuestion(question: string, position: number) {
  const matches = [...question.toLocaleLowerCase("vi").matchAll(/(?:^|[^\p{L}\p{N}])(?:đầu\s+tiên|thứ\s+(10|[1-9]|nhất|hai|ba|tư|bốn|năm|sáu|bảy|tám|chín|mười))(?![\p{L}\p{N}]|[.,]\d|\s+(?:mươi|mốt|một|hai|ba|tư|bốn|lăm|năm|sáu|bảy|tám|chín)(?![\p{L}\p{N}]))/gu)];
  const positions = matches.map((match) => match[1] ? words[match[1]] ?? Number(match[1]) : 1);
  return positions.length === 1 && positions[0] === position;
}

export async function answerPreviousItemCover(businessId: string, previous: unknown, position: unknown) {
  if (!isPreviousItemPosition(position)) throw new HttpError(400, "Vị trí mã hàng không hợp lệ.");
  const list = previousList(previous);
  if (!list) throw new HttpError(400, "Hãy xem lại một danh sách mã hàng trước khi hỏi tiếp.");
  const item = list.items[position - 1];
  if (!item) throw new HttpError(400, `Danh sách vừa xem chỉ có ${list.items.length} mã; hãy chọn vị trí đã hiển thị.`);
  const outlook = await inventoryOutlook(businessId, {}, { variantIds: [item.variantId], all: true });
  const dataAsOf = outlook.latestRun?.dataAsOf ?? null;
  const finishedAt = outlook.latestRun?.finishedAt?.toISOString() ?? null;
  const fresh = outlook.state === "READY" && "ruleFresh" in outlook && outlook.ruleFresh === true && !!dataAsOf && !!finishedAt;
  if (fresh && !outlook.items) throw new Error("Inventory outlook is missing current items.");
  const signals = fresh ? outlook.items?.find((row) => row.variantId === item.variantId)?.signals
    .filter((signal) => signal.current && (signal.type === "LOW_STOCK" || signal.type === "OVERSTOCK")) ?? [] : [];
  const metrics = signals.map((signal) => ({
    stock: signal.metrics.stockAvailable, days: signal.metrics.daysOfCover,
    possibleStockoutBias: signal.metrics.possibleStockoutBias,
  }));
  const first = metrics[0];
  const stock = first && typeof first.stock === "number" && Number.isFinite(first.stock) && first.stock >= 0 ? first.stock : null;
  const days = first && typeof first.days === "number" && Number.isFinite(first.days) && first.days >= 0 ? first.days : null;
  const bias = typeof first?.possibleStockoutBias === "boolean" ? first.possibleStockoutBias : null;
  const valid = stock !== null && days !== null && metrics.every((entry) => entry.stock === stock && entry.days === days);
  const warningCodes = "warnings" in outlook ? outlook.warnings?.map((warning) => warning.code) ?? null : null;
  const partial = list.partial || list.truncated || bias === null || warningCodes === null ||
    warningCodes.some((code) => code === "INSUFFICIENT_HISTORY" || code === "NO_SALES_DATA");
  const evidence = {
    type: "previous_item_cover_v1" as const, item, position,
    state: valid ? partial ? "partial" as const : "ready" as const : "unavailable" as const,
    stockAvailable: valid ? stock : null,
    daysOfCover: valid ? days : null,
    possibleStockoutBias: valid ? bias : null,
    dataAsOf, finishedAt,
    warningCodes, sourcePartial: list.partial, sourceTruncated: list.truncated, sourceInventoryCaution: list.inventoryCaution,
  };
  const text = valid
    ? `Mã ${item.sku} (${item.product}) ở vị trí thứ ${position} có khoảng ${days} ngày bán theo tốc độ bán trung bình gần đây tại lần phân tích tồn kho. Đây chỉ là ước tính, không đảm bảo đủ hàng.${partial ? " Danh sách hoặc dữ liệu phân tích có thể chưa đầy đủ." : ""}${bias === true ? " Mã này có thể từng hết hàng, nên mức bán có thể chưa phản ánh hết nhu cầu." : ""}`
    : `Chưa có thông tin đủ mới và phù hợp để ước tính số ngày bán của mã ${item.sku} (${item.product}); không thể kết luận là hết hàng hay còn đủ hàng.`;
  return { text, evidence };
}
