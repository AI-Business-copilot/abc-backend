const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

const { answerPreviousActions, hasPreviousActions } = require("../src/modules/assistant/previous-actions.service");
const item = { variantId: "00000000-0000-4000-8000-000000000001", sku: "SKU", product: "Áo" };
const prior = (type) => ({
  type, state: "ready", riskState: "ready", totalSku: 1, items: [item],
  warnings: { excludedSaleItems: 0, excludedReturnItems: 0, missingReturnCostLinks: 0 },
  finishedAt: "2026-04-27T00:00:00.000Z", inventoryAsOf: "2026-04-27T01:00:00.000Z",
});

test("combines only actions from the conditions in the displayed result", () => {
  const { evidence, text } = answerPreviousActions({
    ...prior("top_sellers_overstock_near_expiry_v1"), state: "partial", totalSku: 3,
    warningCodes: ["FORECAST_OVERDUE_PO"], items: [{ ...item, possibleStockoutBias: true }],
  });
  assert.deepEqual(evidence.items, [item]);
  assert.deepEqual(evidence.conditions, ["Cảnh báo tồn nhiều", "Có lô sắp hết hạn"]);
  assert.equal(evidence.actions.length, 2);
  assert.match(evidence.actions[0], /tồn thực tế/);
  assert.match(evidence.actions[1], /tình trạng có thể bán/);
  assert.deepEqual(evidence.sourceTimes, [
    { label: "Phân tích tồn kho hoàn tất", at: "2026-04-27T00:00:00.000Z" },
    { label: "Tồn lô được đọc", at: "2026-04-27T01:00:00.000Z" },
  ]);
  assert.equal(evidence.sourcePartial, true);
  assert.equal(evidence.sourceTruncated, true);
  assert.equal(evidence.sourceInventoryCaution, true);
  assert.equal(evidence.overdueOrders, true);
  assert.equal(evidence.possibleStockoutBias, true);
  assert.match(text, /có thể đã thay đổi/);
});

test("combines restock and overstock guidance without repeating their shared analysis time", () => {
  const { evidence } = answerPreviousActions(prior("top_sellers_restock_overstock_v1"));
  assert.deepEqual(evidence.conditions, ["Có gợi ý nhập đang chờ", "Cảnh báo tồn nhiều"]);
  assert.equal(evidence.actions.length, 2);
  assert.match(evidence.actions[0], /gợi ý nhập/);
  assert.match(evidence.actions[1], /tốc độ bán/);
  assert.deepEqual(evidence.sourceTimes, [
    { label: "Phân tích tồn kho hoàn tất", at: "2026-04-27T00:00:00.000Z" },
  ]);
});

test("limits guidance to supported nonempty results and preserves uncertain timestamps", () => {
  for (const type of ["sku_stockout_v1", "top_sellers_overstock_v1", "top_sellers_near_expiry_v1",
    "previous_near_expiry_v1", "slow_expiry_v1", "overstock_forecast_v1", "profit_restock_v1", "previous_restock_v1"]) {
    assert.equal(hasPreviousActions(prior(type)), true, type);
    assert.ok(answerPreviousActions(prior(type)).evidence.actions.length);
  }
  assert.match(answerPreviousActions(prior("slow_expiry_v1")).evidence.actions[0], /đã hết hạn hoặc không thể bán/);
  assert.deepEqual(answerPreviousActions({ ...prior("top_sellers_overstock_v1"), finishedAt: "bad" }).evidence.sourceTimes,
    [{ label: "Phân tích tồn kho hoàn tất", at: null }]);
  for (const value of [
    prior("top_sellers_v1"),
    { ...prior("top_sellers_overstock_v1"), items: [], totalSku: 0 },
    { ...prior("top_sellers_overstock_v1"), state: "unavailable" },
    { ...prior("sku_stockout_v1"), riskState: "unavailable" },
    { ...prior("top_sellers_overstock_v1"), items: [item, item] },
  ]) {
    assert.equal(hasPreviousActions(value), false);
    assert.throws(() => answerPreviousActions(value), /Hãy xem lại danh sách/);
  }
});
