const cases = [];
const listContexts = new Set(["top_sellers", "top_sellers_overstock", "slow_moving_expiry", "top_sellers_restock", "top_sellers_restock_overstock"]);
const queryContexts = new Set(["top_sellers", "top_sellers_overstock"]);

function add(group, expectation, questions, context = {}) {
  for (const [id, question] of questions) {
    const previous = context.previous;
    const expectedContext = {
      hasPreviousSkuList: previous !== undefined && listContexts.has(previous),
      ...(expectation.kind === "change_sku_period" ? { hasPreviousSkuQuery: previous !== undefined && queryContexts.has(previous) } : {}),
      ...(expectation.kind === "change_comparison_metric" ? { hasPreviousComparison: previous === "comparison_store" } : {}),
      ...(expectation.kind === "comparison_breakdown" ? { hasPreviousComparisonBreakdown: previous === "comparison_store" } : {}),
      ...(expectation.kind === "compare_previous_sku_sales" ? { hasComparableRanking: previous === "top_sellers" } : {}),
      ...(expectation.kind === "previous_actions" ? { hasPreviousActions: previous === "top_sellers_restock_overstock" } : {}),
    };
    cases.push({
      id, group, question, hasPreviousRanking: context.hasPreviousRanking === true,
      ...(previous ? { previous } : {}),
      expectedContext,
      expected: expectation,
    });
  }
}

add("ranking", { kind: "top_sellers" }, [
  ["rank-1", "Những mã hàng nào bán chạy gần đây?"],
  ["rank-2", "Cho tôi xem các mã bán nhiều nhất dạo này."],
  ["rank-3", "Top 5 mã bán nhiều nhất trong 7 ngày hoàn chỉnh gần nhất là gì?"],
]);
add("stockout", { kind: "top_sellers_stockout" }, [
  ["stockout-1", "Trong các mã bán chạy gần đây, mã nào có nguy cơ hết hàng cao?"],
  ["stockout-2", "Mã bán chạy nào đang có cảnh báo hết hàng khẩn cấp?"],
]);
add("overstock", { kind: "top_sellers_overstock" }, [
  ["overstock-1", "Mã bán chạy nào đang có cảnh báo tồn nhiều?"],
  ["overstock-2", "Trong các mã bán nhiều gần đây, mã nào bị cảnh báo dư tồn?"],
]);
add("near-expiry", { kind: "top_sellers_near_expiry" }, [
  ["expiry-1", "Mã bán chạy nào có lô còn hàng sắp hết hạn?"],
  ["expiry-2", "Trong các mã bán nhiều gần đây, mã nào có lô gần đến hạn dùng?"],
]);
add("restock", { kind: "top_sellers_restock" }, [
  ["restock-1", "Mã bán chạy nào có gợi ý nhập đang chờ?"],
  ["restock-2", "Mã nào bán chạy gần đây mà cần nhập thêm?"],
]);
add("composition", { kind: "top_sellers_composed", filters: ["overstock", "near_expiry"] }, [
  ["pair-1", "Mã bán chạy nào vừa tồn nhiều vừa có lô sắp hết hạn?"],
  ["pair-2", "Trong các mã bán nhiều gần đây, mã nào có lô gần hạn và cảnh báo tồn nhiều?"],
]);
add("composition", { kind: "top_sellers_composed", filters: ["pending_restock", "near_expiry"] }, [
  ["pair-3", "Mã bán chạy nào có gợi ý nhập và có lô sắp hết hạn?"],
  ["pair-4", "Mã nào bán chạy, có lô gần hạn nhưng cũng cần nhập thêm?"],
]);
add("composition", { kind: "top_sellers_composed", filters: ["pending_restock", "overstock"] }, [
  ["pair-5", "Mã bán chạy nào có gợi ý nhập nhưng đang tồn nhiều?"],
  ["pair-6", "Trong các mã bán nhiều gần đây, mã nào vừa được cảnh báo dư tồn vừa cần nhập?"],
]);
add("other-conditions", { kind: "slow_moving_expiry" }, [
  ["slow-1", "Hàng nào vừa có cảnh báo bán chậm vừa có nguy cơ không bán hết trước hạn?"],
  ["slow-2", "Mã nào bán chậm và đang được cảnh báo nguy cơ hết hạn?"],
]);
add("other-conditions", { kind: "overstock_forecast" }, [
  ["forecast-1", "Hàng tồn nhiều nào có dự báo nhu cầu giảm?"],
  ["forecast-2", "Mã có cảnh báo tồn nhiều nào dự kiến bán chậm hơn?"],
]);
add("other-conditions", { kind: "profit_restock" }, [
  ["profit-1", "Mã nào có lợi nhuận gộp cao và có gợi ý nhập đang chờ?"],
  ["profit-2", "Trong hàng cần nhập, mã nào tạo lãi gộp cao?"],
]);
add("comparison", { kind: "comparison", comparison: {
  metric: "netRevenue", from: "2024-02-01", to: "2024-02-29", subjectType: "store",
} }, [
  ["comparison-1", "Doanh thu từ 2024-02-01 đến 2024-02-29 so với kỳ trước thế nào?"],
  ["comparison-2", "So với kỳ trước, doanh thu thuần 2024-02-01 đến 2024-02-29 tăng hay giảm?"],
]);
add("comparison", { kind: "comparison", comparison: {
  metric: "grossProfit", from: "2024-02-01", to: "2024-02-29", subjectType: "sku", subject: "MA-GIA-01",
} }, [
  ["comparison-3", "Lợi nhuận gộp mã MA-GIA-01 từ 2024-02-01 đến 2024-02-29 so với kỳ trước?"],
]);
add("follow-up-period", { kind: "change_sku_period", periodChange: "last_week" }, [
  ["follow-period-1", "Cùng câu đó cho tuần trước theo lịch thì sao?"],
  ["follow-period-2", "Xem lại câu vừa rồi cho tuần trước."],
], { hasPreviousRanking: true, previous: "top_sellers" });
add("follow-up-period", { kind: "change_sku_period", periodChange: "previous_period" }, [
  ["follow-period-3", "Cùng câu đó cho kỳ liền trước có cùng số ngày?"],
], { previous: "top_sellers_overstock" });
add("follow-up-list", { kind: "previous_restock" }, [
  ["follow-list-1", "Trong các mã vừa xem, mã nào có gợi ý nhập?"],
  ["follow-list-2", "Những mã vừa hiển thị, mã nào cần ưu tiên nhập?"],
], { previous: "slow_moving_expiry" });
add("follow-up-list", { kind: "previous_near_expiry" }, [
  ["follow-list-3", "Trong các mã vừa hiển thị, mã nào có lô sắp hết hạn?"],
], { previous: "top_sellers_restock" });
add("follow-up-list", { kind: "previous_stockout" }, [
  ["follow-list-4", "Trong các mã bán chạy vừa xem, mã nào có nguy cơ hết hàng cao?"],
], { hasPreviousRanking: true, previous: "top_sellers" });
add("follow-up-list", { kind: "compare_previous_sku_sales" }, [
  ["follow-list-5", "Số bán các mã vừa xem so với kỳ liền trước cùng số ngày thế nào?"],
], { hasPreviousRanking: true, previous: "top_sellers" });
add("follow-up-overstock", { kind: "previous_overstock" }, [
  ["follow-overstock-1", "Trong số đó mã nào tồn nhiều?"],
  ["follow-overstock-2", "Trong danh sách vừa xem, mã nào có cảnh báo tồn nhiều?"],
], { hasPreviousRanking: true, previous: "top_sellers" });
add("follow-up-item", { kind: "previous_item_cover", position: 1 }, [
  ["follow-item-1", "Mã đầu tiên còn bao nhiêu ngày bán?"],
], { previous: "top_sellers_restock" });
add("follow-up-item", { kind: "previous_item_cover", position: 2 }, [
  ["follow-item-2", "Mã thứ 2 còn bao nhiêu ngày bán?"],
], { hasPreviousRanking: true, previous: "top_sellers" });
add("follow-up-actions", { kind: "previous_actions" }, [
  ["follow-action-1", "Vậy nên làm gì?"],
  ["follow-action-2", "Nên xử lý những hàng vừa xem thế nào?"],
], { previous: "top_sellers_restock_overstock" });
add("follow-up-comparison", { kind: "change_comparison_metric", metric: "grossProfit" }, [
  ["follow-metric-1", "Còn lợi nhuận gộp thì sao?"],
], { previous: "comparison_store" });
add("follow-up-comparison", { kind: "comparison_breakdown", level: "product" }, [
  ["follow-detail-1", "Xem chi tiết theo từng sản phẩm."],
], { previous: "comparison_store" });
add("clarification", { kind: "clarify_comparison", clarification: "Hãy hỏi lại và cho biết muốn xem doanh thu thuần hay lợi nhuận gộp." }, [
  ["clarify-1", "Còn lợi nhuận thì sao?"],
], { previous: "comparison_store" });
add("clarification", { kind: "clarify_comparison", clarification: "Hãy hỏi lại và cho biết khoảng thời gian muốn xem, ví dụ 7 ngày gần nhất hoặc tuần này." }, [
  ["clarify-2", "Doanh thu so với kỳ trước thay đổi thế nào?"],
]);
add("unsupported", { kind: "unsupported" }, [
  ["unsupported-1", "Mã bán chạy tuần này nào có lô sắp hết hạn?"],
  ["unsupported-2", "Cho tôi 10 mã bán chạy gần đây."],
  ["unsupported-3", "Mã bán chạy nào tồn nhiều, cần nhập và có lô sắp hết hạn?"],
  ["unsupported-4", "Mã bán chạy nào tồn nhiều và có lô đã hết hạn?"],
  ["unsupported-5", "Mã bán chạy nào có nguy cơ không bán hết trước hạn?"],
  ["unsupported-10", "Vì sao doanh thu tháng này giảm?"],
  ["unsupported-11", "Lợi nhuận ròng tháng này so với tháng trước?"],
  ["unsupported-12", "Mã bán chạy nào có tỷ suất lãi thấp?"],
]);
add("unsupported", { kind: "unsupported" }, [
  ["unsupported-6", "Trong danh sách vừa xem, chỉ tính áo thun."],
  ["unsupported-7", "Mã đầu tiên và mã thứ 2 còn bao nhiêu ngày bán?"],
  ["unsupported-8", "Mã cuối cùng còn bao nhiêu ngày bán?"],
  ["unsupported-9", "Tạo đơn nhập cho những mã vừa xem."],
  ["unsupported-14", "Số bán các mã vừa xem so với tháng trước theo lịch?"],
], { hasPreviousRanking: true, previous: "top_sellers" });

module.exports = cases;
