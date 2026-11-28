import { HttpError } from "../../shared/http/http-error";
import { previousList } from "./previous-restock.service";
import { skuCompositionForEvidence, type CompositionCondition } from "./sku-composition-contracts";

const actions = {
  stockout: "Kiểm tra tồn thực tế và hàng đang về; xem gợi ý nhập trước khi quyết định đặt thêm.",
  overstock: "Kiểm tra tồn thực tế và tốc độ bán; cân nhắc lượng hàng đang về trước khi nhập thêm.",
  nearExpiry: "Kiểm tra từng lô, hạn dùng và tình trạng có thể bán; ưu tiên xử lý lô gần hạn phù hợp.",
  slowExpiry: "Kiểm tra từng lô và tốc độ bán; tách hàng đã hết hạn hoặc không thể bán để xử lý theo quy định.",
  forecast: "Đối chiếu dự báo với tình hình bán thực tế trước khi điều chỉnh kế hoạch nhập.",
  restock: "Xem lại gợi ý nhập, tồn thực tế, hàng đang về, nhà cung cấp và các cảnh báo tồn nhiều hoặc hạn dùng trước khi quyết định đặt hàng.",
} as const;
type Action = keyof typeof actions;

type SourceTime = { field: string; label: string };
const analysisTime = (field: string): SourceTime => ({ field, label: "Phân tích tồn kho hoàn tất" });
const lotTime: SourceTime = { field: "inventoryAsOf", label: "Tồn lô được đọc" };
const compositionConditions: Record<CompositionCondition, { label: string; action: Action; time: SourceTime }> = {
  overstock: { label: "Cảnh báo tồn nhiều", action: "overstock", time: analysisTime("finishedAt") },
  near_expiry: { label: "Có lô sắp hết hạn", action: "nearExpiry", time: lotTime },
  pending_restock: { label: "Có gợi ý nhập đang chờ", action: "restock", time: analysisTime("finishedAt") },
};
const contracts: Record<string, { conditions: string[]; actions: Action[]; timeFields: SourceTime[] }> = {
  sku_stockout_v1: { conditions: ["Nguy cơ hết hàng cao hoặc khẩn cấp"], actions: ["stockout"], timeFields: [analysisTime("riskFinishedAt")] },
  top_sellers_overstock_v1: { conditions: ["Cảnh báo tồn nhiều"], actions: ["overstock"], timeFields: [analysisTime("finishedAt")] },
  top_sellers_near_expiry_v1: { conditions: ["Có lô sắp hết hạn"], actions: ["nearExpiry"], timeFields: [lotTime] },
  previous_near_expiry_v1: { conditions: ["Có lô sắp hết hạn"], actions: ["nearExpiry"], timeFields: [lotTime] },
  slow_expiry_v1: { conditions: ["Cảnh báo bán chậm", "Cảnh báo nguy cơ hết hạn"], actions: ["slowExpiry"], timeFields: [analysisTime("finishedAt")] },
  overstock_forecast_v1: { conditions: ["Cảnh báo tồn nhiều", "Dự báo bán giảm"], actions: ["overstock", "forecast"], timeFields: [analysisTime("finishedAt")] },
  profit_restock_v1: { conditions: ["Có gợi ý nhập đang chờ"], actions: ["restock"], timeFields: [analysisTime("riskFinishedAt")] },
  previous_restock_v1: { conditions: ["Có gợi ý nhập đang chờ"], actions: ["restock"], timeFields: [analysisTime("finishedAt")] },
  previous_overstock_v1: { conditions: ["Cảnh báo tồn nhiều"], actions: ["overstock"], timeFields: [analysisTime("finishedAt")] },
  top_sellers_restock_v1: { conditions: ["Có gợi ý nhập đang chờ"], actions: ["restock"], timeFields: [analysisTime("finishedAt")] },
};

function actionContract(type: string) {
  const composition = skuCompositionForEvidence(type);
  if (!composition) return Object.prototype.hasOwnProperty.call(contracts, type) ? contracts[type] : undefined;
  const conditions = composition.conditions.map((condition) => compositionConditions[condition]);
  const timeFields = conditions.map((condition) => condition.time)
    .filter((time, index, all) => all.findIndex((other) => other.field === time.field && other.label === time.label) === index);
  return { conditions: conditions.map((condition) => condition.label), actions: conditions.map((condition) => condition.action), timeFields };
}

function context(value: unknown) {
  const list = previousList(value);
  if (!list || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const contract = typeof data.type === "string" ? actionContract(data.type) : undefined;
  if (!contract) return null;
  const sourceTimes = contract.timeFields.map(({ field, label }) => {
    const time = data[field];
    return { label, at: typeof time === "string" && !Number.isNaN(Date.parse(time)) ? time : null };
  });
  const warningCodes = Array.isArray(data.warningCodes) ? data.warningCodes : [];
  const possibleStockoutBias = warningCodes.includes("POSSIBLE_STOCKOUT_BIAS") ||
    (Array.isArray(data.items) && data.items.some((item: unknown) =>
      !!item && typeof item === "object" && "possibleStockoutBias" in item && item.possibleStockoutBias === true));
  return { list, contract, sourceTimes, overdueOrders: warningCodes.includes("FORECAST_OVERDUE_PO"), possibleStockoutBias };
}

export function hasPreviousActions(value: unknown) {
  return context(value) !== null;
}

export function answerPreviousActions(value: unknown) {
  const previous = context(value);
  if (!previous) throw new HttpError(400, "Hãy xem lại danh sách có cảnh báo tồn kho hoặc gợi ý nhập trước khi hỏi nên làm gì.");
  const { list, contract, sourceTimes, overdueOrders, possibleStockoutBias } = previous;
  const evidence = {
    type: "previous_actions_v1" as const,
    items: list.items,
    conditions: contract.conditions,
    actions: contract.actions.map((action) => actions[action]),
    sourceTimes,
    sourcePartial: list.partial,
    sourceTruncated: list.truncated,
    sourceInventoryCaution: list.inventoryCaution,
    overdueOrders, possibleStockoutBias,
  };
  const text = `Với ${list.items.length} mã đã hiển thị, bạn có thể: ${evidence.actions.join(" ")} Kết quả trước có thể đã thay đổi; hãy kiểm tra lại trước khi quyết định.`;
  return { text, evidence };
}
