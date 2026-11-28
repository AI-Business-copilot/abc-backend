import { HttpError } from "../../shared/http/http-error";
import { previousList } from "./previous-restock.service";
import { matchingExpiryLots, nearExpiryLots } from "./top-seller-inventory.service";

export async function answerPreviousNearExpiry(businessId: string, previous: unknown) {
  const list = previousList(previous);
  if (!list) throw new HttpError(400, "Hãy xem lại một danh sách mã hàng trước khi hỏi tiếp.");
  const { asOf, today, lots } = await nearExpiryLots(businessId, list.items.map((item) => item.variantId));
  const items = list.items.flatMap((item) => {
    const matching = matchingExpiryLots(item.variantId, lots);
    return matching ? [{ ...item, ...matching }] : [];
  });
  const evidence = {
    type: "previous_near_expiry_v1" as const, state: list.partial ? "partial" as const : "ready" as const,
    sourceCount: list.items.length, sourcePartial: list.partial, sourceTruncated: list.truncated,
    sourceInventoryCaution: true, inventoryAsOf: asOf.toISOString(), inventoryDay: today,
    totalSku: items.length, items,
  };
  const text = items.length
    ? `Trong ${list.items.length} mã vừa hiển thị, có ${items.length} mã có lô sắp hết hạn.`
    : `Trong ${list.items.length} mã vừa hiển thị, chưa tìm thấy mã có lô sắp hết hạn.`;
  return { text, evidence };
}
