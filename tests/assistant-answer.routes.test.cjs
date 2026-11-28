const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
require("ts-node/register/transpile-only");
const classifierCases = require("./fixtures/assistant-classifier-cases.cjs");

function mock(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
const id = "77777777-7777-4777-8777-777777777777";
const productId = "88888888-8888-4888-8888-888888888888";
const variantId = "99999999-9999-4999-8999-999999999999";
const comparison = {
  current: { netRevenue: "9007199254740993.00", grossProfit: "20.00" },
  previous: { netRevenue: "9007199254740994.00", grossProfit: "40.00" },
  changes: { netRevenue: { difference: "-1.00", percent: "-0.00" }, grossProfit: { difference: "-20.00", percent: "-50.00" } },
};
let reads = [];
let messages = [];
let storedPermissions = [];
let enabled = true;
let llmRequests = [];
let llmError = null;
let llmText = '{"kind":"top_sellers"}';
let extraMovementItems = [];
let includeMovementProduct = true;
mock("../src/modules/assistant/openai-client", { requestOpenAiText: async (request) => {
  llmRequests.push(request);
  if (llmError) throw llmError;
  return llmText;
} });
mock("../src/shared/auth/supabase-auth.middleware", { requireSupabaseIdentity: (_req, _res, next) => next() });
mock("../src/shared/auth/business-scope.middleware", { requireBusinessScope: (req, res, next) => {
  res.locals.businessId = String(req.headers["x-business"] || "business-a");
  res.locals.userId = String(req.headers["x-user"] || "user-a");
  res.locals.permissionCodes = String(req.headers["x-permissions"] || "").split(",");
  next();
} });
mock("../src/modules/business-data/business-movement.service", { getBusinessMovement: async (businessId, query) => {
  reads.push({ businessId, query });
  return {
    ranges: { current: { from: "2026-04-20", to: "2026-04-26", dayCount: 7 }, previous: { from: "2026-04-13", to: "2026-04-19", dayCount: 7 } },
    asOf: new Date("2026-04-27T00:00:00Z"),
    warnings: { excludedSaleItems: 1, excludedReturnItems: 0, missingReturnCostLinks: 0 },
    totals: comparison, items: [...(includeMovementProduct ? [{ id: productId, name: "Áo", ...comparison, variants: [{ id: variantId, sku: "SKU", ...comparison }] }] : []), ...extraMovementItems],
  };
} });
let skuReads = [];
let skuQueries = [];
let changedContext = false;
let skuPreviousUnits = 8;
mock("../src/modules/business-data/product-performance.service", { getProductPerformance: async (businessId, query) => {
  skuReads.push(businessId);
  skuQueries.push(query);
  const end = new Date(`${query.from}T00:00:00Z`); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6);
  return {
    asOf: new Date("2026-04-27T00:00:00Z"),
    warnings: { excludedSaleItems: 0, excludedReturnItems: 0, missingReturnCostLinks: 0 },
    ranges: { current: { from: query.from, to: query.to, dayCount: 7 }, previous: { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10), dayCount: 7 } },
    items: [{ name: "Synthetic shirt", variants: [{ id: variantId, sku: "TEST-SKU", current: { unitsSold: 20, grossProfit: "123.00" }, previous: { unitsSold: skuPreviousUnits } }] }],
  };
} });
mock("../src/modules/ai-insights/inventory-outlook.service", { inventoryOutlook: async (businessId, _query, options) => {
  skuReads.push(businessId);
  if (options.all && options.variantIds) assert.deepEqual(options.variantIds, [variantId]);
  if (options.all) return {
    state: "READY", ruleFresh: true, forecastReady: true, warnings: [],
    latestRun: { dataAsOf: "2026-04-26", finishedAt: new Date("2026-04-27T00:00:00Z") },
    ...(options.includeForecastComparison ? { forecastContext: {
      today: "2026-04-27",
      latest: { id: "run", status: "SUCCEEDED", dataAsOf: new Date("2026-04-26T00:00:00Z"),
        finishedAt: new Date("2026-04-27T00:00:00Z"), summary: { publicationVersion: 1, forecastStatus: "READY" } },
      forecasts: [{ variantId, runId: "run", asOf: new Date("2026-04-26T00:00:00Z"), status: "OK", model: "SES", confidence: "MEDIUM",
        updatedAt: new Date("2026-04-27T00:00:00Z"), result: { nextDayForecast: {
          status: "OK", policy: "next-day-v1", totals: { d7: 3, d14: 6, d28: 12 },
        } } }],
      sales: [{ variantId, _sum: { unitsSold: 30 } }],
    } } : {}),
    items: [{ variantId, sku: "TEST-SKU", productName: "Synthetic shirt",
      replenishment: { status: "PENDING", current: true, suggestedQty: 4, urgency: "HIGH", supplierName: null, orderByDate: null, stockoutDate: null }, signals: [
      { type: "SLOW_MOVING", current: true, metrics: { sold30: 1 } },
      { id: "lot", type: "EXPIRATION_RISK", current: true, severity: "LOW", reasonCode: "EXPIRED_IN_STOCK", lotNumber: "TEST-LOT", expirationDate: "2026-04-01", metrics: {} },
      { type: "OVERSTOCK", current: true, severity: "HIGH", metrics: { stockAvailable: 100, daysOfCover: 90, thresholdDays: 60 } },
    ] }],
  };
  assert.deepEqual(options.variantIds, [variantId]);
  return {
    state: "READY", ruleFresh: true, forecastReady: true,
    latestRun: { dataAsOf: "2026-04-26", finishedAt: new Date("2026-04-27T00:00:00Z") },
    items: [{ variantId, signals: [{ type: "STOCKOUT_RISK", current: true, severity: "HIGH", metrics: {} }] }],
  };
} });
const prisma = {
  business: {
    findUniqueOrThrow: async () => ({ assistantOpenaiEnabled: enabled }),
    update: async ({ data }) => { enabled = data.assistantOpenaiEnabled; return { assistantOpenaiEnabled: enabled }; },
  },
  businessMembership: { findFirst: async ({ where }) => where.userId === "owner" && where.role.code === "OWNER" ? { id: "membership" } : null },
  assistantConversation: {
    findFirst: async ({ where }) => where.id === id && where.businessId === "business-a" && where.userId === "user-a"
      ? { messages: [...messages].reverse().concat(storedPermissions.map((requiredPermissions) => ({ requiredPermissions }))) } : null,
    updateMany: async ({ where }) => ({ count: where.id === id && where.businessId === "business-a" ? 1 : 0 }),
  },
  assistantMessage: {
    findMany: async () => [...messages, ...storedPermissions.map((requiredPermissions) => ({ requiredPermissions }))],
    findFirst: async ({ where }) => where.role && changedContext
      ? { id: "changed" }
      : [...messages].reverse().find((message) => !where.role || message.role === where.role) ?? null,
    create: async ({ data }) => { const item = { id: String(messages.length), ...data }; messages.push(item); return item; },
  },
  $queryRaw: async (parts) => String(parts[0]).includes('SELECT NOW()')
    ? [{ asOf: new Date("2026-04-27T00:00:00Z"), today: "2026-04-27" }]
    : [{ variantId, lotItemId: "lot", lotNumber: "L1", expirationDate: "2026-04-30", status: "ACTIVE", alertDays: 30, quantity: 8, damaged: 0 }],
  $transaction: async (fn) => fn(prisma),
};
mock("../src/shared/infrastructure/database/prisma.client", { prisma });
const router = require("../src/modules/assistant/assistant.routes").default;
const body = { question: "Doanh thu?", metric: "netRevenue", from: "2026-04-20", to: "2026-04-26", productId, variantId };

async function withServer(run) {
  const app = express(); app.use(express.json()); app.use(router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}/conversations/${id}/messages`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
function post(url, data, headers = {}) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-permissions": "analytics.read,finance.read", ...headers }, body: JSON.stringify(data) });
}

function classifierResponse(item) {
  if (item.expected.kind === "comparison") {
    return JSON.stringify({ kind: "comparison", ...item.expected.comparison, period: "dates" });
  }
  if (item.expected.kind === "clarify_comparison") {
    const missing = item.expected.clarification.includes("doanh thu thuần") ? "metric" : "period";
    return JSON.stringify({ kind: "clarify_comparison", missing });
  }
  return JSON.stringify(item.expected);
}

function previousEvidenceFor(scenario) {
  const period = { from: "2026-04-20", to: "2026-04-26" };
  const item = { variantId, sku: "SYNTHETIC-SKU", product: "Synthetic shirt", unitsSold: 20 };
  const warnings = { excludedSaleItems: 0, excludedReturnItems: 0, missingReturnCostLinks: 0 };
  const rank = { version: 1, entity: "sku", rank: {
    metric: "units_sold_before_returns", period, limit: 5,
  } };
  if (scenario === "comparison_store") return {
    source: "POS", type: "comparison_v1", metric: "netRevenue",
    ranges: {
      current: { from: "2026-04-20", to: "2026-04-26", dayCount: 7 },
      previous: { from: "2026-04-13", to: "2026-04-19", dayCount: 7 },
    },
    subject: null,
  };
  if (scenario === "top_sellers" || scenario === "top_sellers_overstock") {
    const analysis = scenario;
    const type = scenario === "top_sellers" ? "top_sellers_v1" : "top_sellers_overstock_v1";
    return {
      type, analysis, period, salesAsOf: "2026-04-27T00:00:00.000Z", warnings,
      ...(scenario === "top_sellers_overstock" ? { state: "ready", totalSku: 1 } : {}),
      items: [item],
      query: {
        ...rank,
        filter: scenario === "top_sellers" ? null : { condition: "overstock" },
      },
    };
  }
  const typeByScenario = {
    slow_moving_expiry: "slow_expiry_v1",
    top_sellers_restock: "top_sellers_restock_v1",
    top_sellers_restock_overstock: "top_sellers_restock_overstock_v1",
  };
  const type = typeByScenario[scenario];
  if (!type) throw new Error(`Unknown classifier context scenario: ${scenario}`);
  return { type, state: "ready", totalSku: 1, items: [item] };
}

test("saves a scoped grounded pair with exact values, evidence, permissions and stable order", async () => {
  reads = []; messages = []; storedPermissions = []; llmRequests = []; enabled = true; llmError = null;
  await withServer(async (url) => {
    const response = await post(url, body);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.deepEqual(reads, [{ businessId: "business-a", query: { from: body.from, to: body.to } }]);
    assert.match(result.messages[1].content, /9007199254740993\.00.*giảm 1\.00/);
    assert.match(result.messages[1].content, /cảnh báo dữ liệu/);
    assert.equal(llmRequests.length, 0);
    assert.equal(result.messages[1].evidence.current, "9007199254740993.00");
    assert.equal(result.messages[1].evidence.percent, "-0.00");
    assert.equal(result.messages[1].evidence.subject.sku, "SKU");
    assert.deepEqual(messages.map((message) => message.requiredPermissions), [["analytics.read", "finance.read"], ["analytics.read", "finance.read"]]);
    assert.ok(messages[0].createdAt < messages[1].createdAt);
    assert.equal((await post(url, body)).status, 201);
    assert.ok(messages[1].createdAt < messages[2].createdAt);
  });
});

test("rejects missing permissions, other stores, revoked history and invalid selections before saving", async () => {
  reads = []; messages = []; storedPermissions = []; enabled = true; llmError = null;
  await withServer(async (url) => {
    assert.equal((await post(url, body, { "x-permissions": "analytics.read" })).status, 403);
    assert.equal((await post(url, body, { "x-business": "business-b" })).status, 404);
    storedPermissions = [["inventory.read"]];
    assert.equal((await post(url, body)).status, 403);
    storedPermissions = [];
    assert.equal((await post(url, { ...body, variantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).status, 404);
    assert.equal((await post(url, { ...body, metric: "netProfit" })).status, 400);
    assert.equal(messages.length, 0);
    assert.equal(reads.length, 1);
  });
});

test("owner consent is required and provider failures do not save messages", async () => {
  reads = []; messages = []; storedPermissions = []; llmRequests = []; enabled = false; llmError = null;
  await withServer(async (url) => {
    assert.equal((await post(url, body)).status, 403);
    assert.equal(reads.length, 0);
    assert.equal(llmRequests.length, 0);
    enabled = true;
    llmError = Object.assign(new Error("provider unavailable"), { statusCode: 503 });
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    assert.equal((await post(interpret, { question: "Mặt hàng nào bán chạy?" })).status, 503);
    assert.equal(messages.length, 0);
  });
});

test("classification sends only the question and context flag and validates the provider output", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; llmText = '{"kind":"top_sellers"}';
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const response = await post(interpret, { question: "Mặt hàng nào bán chạy?" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { kind: "top_sellers", hasPreviousRanking: false, hasPreviousSkuList: false });
    assert.deepEqual(JSON.parse(llmRequests[0].input), { question: "Mặt hàng nào bán chạy?", hasPreviousRanking: false });
    llmText = '{"kind":"top_sellers","extra":"untrusted"}';
    assert.equal((await post(interpret, { question: "Mặt hàng nào bán chạy?" })).status, 502);
    llmText = "not json";
    assert.equal((await post(interpret, { question: "Mặt hàng nào bán chạy?" })).status, 502);
    assert.equal((await post(interpret, { question: "Mặt hàng nào bán chạy?" }, { "x-permissions": "analytics.read" })).status, 403);
  });
});

test("classifies every follow-up fixture through realistic synthetic conversation evidence", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; changedContext = false;
  const contextualCases = classifierCases.filter((item) => item.previous);
  assert.equal(contextualCases.length, 22);
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    for (const item of contextualCases) {
      for (const includeContext of [true, false]) {
        const previousMessageId = "synthetic-context";
        messages = includeContext ? [{
          id: previousMessageId,
          role: "assistant",
          requiredPermissions: ["analytics.read", "finance.read"],
          evidence: previousEvidenceFor(item.previous),
        }] : [];
        llmText = classifierResponse(item);
        const response = await post(interpret, {
          question: item.question,
          ...(includeContext ? { conversationId: id } : {}),
        });
        assert.equal(response.status, 200, `${item.id} (${includeContext ? "with" : "without"} context)`);
        const result = await response.json();
        const expectedFlags = Object.fromEntries(Object.entries(item.expectedContext)
          .map(([key, value]) => [key, includeContext && value]));
        const hasContext = (includeContext && item.hasPreviousRanking) || Object.values(expectedFlags).some(Boolean);
        assert.deepEqual(result, {
          ...item.expected,
          hasPreviousRanking: includeContext && item.hasPreviousRanking,
          ...expectedFlags,
          ...(hasContext ? { previousMessageId } : {}),
        }, `${item.id} (${includeContext ? "with" : "without"} context)`);
        assert.deepEqual(JSON.parse(llmRequests.at(-1).input), {
          question: item.question,
          hasPreviousRanking: includeContext && item.hasPreviousRanking,
        });
      }
    }
  });
});

test("natural comparison resolves a named SKU locally and refuses ambiguous matches", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; reads = []; extraMovementItems = [];
  const question = "Doanh thu mã SKU từ 2020-04-20 đến 2020-04-26 so với kỳ trước?";
  llmText = JSON.stringify({ kind: "comparison", metric: "netRevenue", period: "dates", from: "2020-04-20", to: "2020-04-26", subjectType: "sku", subject: "SKU" });
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const response = await post(interpret, { question });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.comparison, { metric: "netRevenue", from: "2020-04-20", to: "2020-04-26", subjectType: "sku", subject: "SKU" });
    assert.deepEqual(JSON.parse(llmRequests[0].input), { question, hasPreviousRanking: false });
    assert.equal((await post(url, { question, ...result.comparison })).status, 201);
    assert.equal(messages[1].evidence.subject.sku, "SKU");
    assert.equal(llmRequests.length, 1);
    assert.deepEqual(reads, [{ businessId: "business-a", query: { from: "2020-04-20", to: "2020-04-26" } }]);
    llmText = '{"kind":"clarify_comparison","missing":"period"}';
    const clarification = await post(interpret, { question: "Doanh thu thay đổi thế nào?", conversationId: id });
    assert.match((await clarification.json()).clarification, /khoảng thời gian/);
    assert.deepEqual(JSON.parse(llmRequests[1].input), { question: "Doanh thu thay đổi thế nào?", hasPreviousRanking: false });
    assert.equal(reads.length, 1);
    const productRequest = { question: "Lợi nhuận gộp sản phẩm áo so với kỳ trước?", metric: "grossProfit", from: "2020-04-20", to: "2020-04-26", subjectType: "product", subject: "áo" };
    assert.equal((await post(url, productRequest)).status, 201);
    assert.equal(messages[3].evidence.subject.productId, productId);
    extraMovementItems = [{ id: "another", name: "ÁO", ...comparison, variants: [] }];
    assert.equal((await post(url, productRequest)).status, 409);
    extraMovementItems = [{ id: "another", name: "Khác", ...comparison, variants: [{ id: "other", sku: "SKU", ...comparison }] }];
    assert.equal((await post(url, { question, ...result.comparison })).status, 409);
    assert.equal(messages.length, 4);
    extraMovementItems = [];
    assert.equal((await post(url, { question, ...result.comparison, subject: "NOT-FOUND" })).status, 404);
    assert.equal((await post(url, { question, ...result.comparison }, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, { question, ...result.comparison }, { "x-permissions": "analytics.read" })).status, 403);
    enabled = false;
    assert.equal((await post(interpret, { question })).status, 403);
    assert.equal(messages.length, 4);
  });
  enabled = true;
});

test("changes a previous comparison metric, reusing its exact scope without sending it to OpenAI", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; reads = []; changedContext = false; extraMovementItems = [];
  llmText = '{"kind":"change_comparison_metric","metric":"grossProfit"}';
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const question = "Còn lợi nhuận gộp thì sao?";
    const noContext = await post(interpret, { question });
    assert.equal((await noContext.json()).hasPreviousComparison, false);
    assert.equal((await post(url, { question, analysis: "change_comparison_metric", metric: "grossProfit" })).status, 400);
    assert.equal((await post(url, body)).status, 201);
    const previousMessage = messages[1];
    const classified = await post(interpret, { question, conversationId: id });
    const context = await classified.json();
    assert.equal(context.hasPreviousComparison, true);
    assert.equal(context.previousMessageId, previousMessage.id);
    assert.deepEqual(JSON.parse(llmRequests[1].input), { question, hasPreviousRanking: false });
    const request = { question, analysis: "change_comparison_metric", metric: "grossProfit", previousMessageId: previousMessage.id,
      productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", from: "2020-01-01" };
    assert.equal((await post(url, { ...request, metric: "netProfit" })).status, 400);
    assert.equal((await post(url, request, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, request, { "x-permissions": "analytics.read" })).status, 403);
    assert.equal((await post(url, { ...request, previousMessageId: "other" })).status, 409);
    storedPermissions = [["inventory.read"]];
    assert.equal((await post(url, request)).status, 403);
    storedPermissions = [];
    enabled = false;
    assert.equal((await post(url, request)).status, 403);
    enabled = true;
    includeMovementProduct = false;
    try {
      assert.equal((await post(url, request)).status, 404);
    } finally {
      includeMovementProduct = true;
    }
    changedContext = true;
    assert.equal((await post(url, request)).status, 409);
    changedContext = false;
    assert.equal(messages.length, 2);
    assert.equal((await post(url, request)).status, 201);
    assert.equal(messages[3].evidence.metric, "grossProfit");
    assert.equal(messages[3].evidence.current, "20.00");
    assert.equal(messages[3].evidence.previous, "40.00");
    assert.deepEqual(messages[3].evidence.subject, previousMessage.evidence.subject);
    assert.deepEqual(messages[3].evidence.ranges, previousMessage.evidence.ranges);
    assert.equal(messages[3].evidence.followUp.previousMessageId, previousMessage.id);
    assert.deepEqual(reads.at(-1), { businessId: "business-a", query: { from: body.from, to: body.to } });
    assert.match(messages[3].content, /chưa trừ chi phí vận hành/);
    assert.equal(llmRequests.length, 2);
    assert.equal((await post(url, { question: "Còn doanh thu?", analysis: "change_comparison_metric", metric: "netRevenue", previousMessageId: messages[3].id })).status, 201);
    assert.equal(messages[5].evidence.current, "9007199254740993.00");
    assert.equal(messages[5].evidence.subject.variantId, variantId);
    for (const output of [
      '{"kind":"change_comparison_metric"}',
      '{"kind":"change_comparison_metric","metric":"netProfit"}',
      '{"kind":"change_comparison_metric","metric":"grossProfit","extra":1}',
    ]) {
      llmText = output;
      assert.equal((await post(interpret, { question })).status, 502);
    }
  });
});

test("metric changes retain store and product scopes from existing comparison evidence", async () => {
  enabled = true; llmError = null; storedPermissions = []; reads = []; changedContext = false; extraMovementItems = [];
  await withServer(async (url) => {
    for (const subject of [null, { product: "Áo", productId }]) {
      messages = [];
      const request = { question: "Doanh thu?", metric: "netRevenue", from: body.from, to: body.to, ...(subject ? { productId } : {}) };
      assert.equal((await post(url, request)).status, 201);
      assert.equal((await post(url, { question: "Còn lợi nhuận gộp?", analysis: "change_comparison_metric", metric: "grossProfit", previousMessageId: messages[1].id })).status, 201);
      assert.deepEqual(messages[3].evidence.subject, subject);
      assert.equal(messages[3].evidence.metric, "grossProfit");
    }
  });
});

test("breaks down a store comparison into products without sharing or trusting context", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; reads = []; changedContext = false;
  llmText = '{"kind":"comparison_breakdown","level":"product"}';
  extraMovementItems = Array.from({ length: 22 }, (_, index) => ({
    id: `p${index}`, name: `Sản phẩm ${index}`, variants: [], ...comparison,
    current: { ...comparison.current, netRevenue: `${index}.00` },
  }));
  try {
    await withServer(async (url) => {
      const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
      const question = "Xem chi tiết theo từng sản phẩm";
      assert.equal((await (await post(interpret, { question })).json()).hasPreviousComparisonBreakdown, false);
      assert.equal((await post(url, { question: "So sánh cửa hàng", metric: "netRevenue", from: body.from, to: body.to })).status, 201);
      const previous = messages[1];
      const interpreted = await (await post(interpret, { question, conversationId: id })).json();
      assert.equal(interpreted.hasPreviousComparisonBreakdown, true);
      assert.equal(interpreted.previousMessageId, previous.id);
      assert.deepEqual(JSON.parse(llmRequests.at(-1).input), { question, hasPreviousRanking: false });
      const request = { question, analysis: "comparison_breakdown", level: "product", previousMessageId: previous.id, from: "2020-01-01", metric: "grossProfit" };
      assert.equal((await post(url, { ...request, level: "sku" })).status, 400);
      assert.equal((await post(url, { ...request, level: "category" })).status, 400);
      assert.equal((await post(url, { ...request, previousMessageId: "old" })).status, 409);
      assert.equal((await post(url, request, { "x-business": "business-b" })).status, 404);
      assert.equal((await post(url, request, { "x-permissions": "analytics.read" })).status, 403);
      storedPermissions = [["inventory.read"]];
      assert.equal((await post(url, request)).status, 403);
      storedPermissions = [];
      changedContext = true;
      assert.equal((await post(url, request)).status, 409);
      changedContext = false;
      assert.equal(messages.length, 2);
      assert.equal((await post(url, request)).status, 201);
      const result = messages[3].evidence;
      assert.equal(result.total, 23);
      assert.equal(result.items.length, 20);
      assert.equal(result.items[0].name, "Áo");
      assert.equal(result.items[0].current, "9007199254740993.00");
      assert.equal(result.items[1].current, "21.00");
      assert.equal(result.metric, "netRevenue");
      assert.deepEqual(result.ranges, previous.evidence.ranges);
      assert.equal(result.warnings.excludedSaleItems, 1);
      assert.equal(result.followUp.previousMessageId, previous.id);
      assert.match(messages[3].content, /chưa hiển thị hết/);
      assert.match(messages[3].content, /cảnh báo dữ liệu/);
      assert.deepEqual(reads.at(-1), { businessId: "business-a", query: { from: body.from, to: body.to } });
      assert.equal((await (await post(interpret, { question, conversationId: id })).json()).hasPreviousComparisonBreakdown, false);
      for (const output of ['{"kind":"comparison_breakdown"}', '{"kind":"comparison_breakdown","level":"category"}', '{"kind":"comparison_breakdown","level":"product","extra":1}']) {
        llmText = output;
        assert.equal((await post(interpret, { question })).status, 502);
      }
    });
  } finally { extraMovementItems = []; changedContext = false; storedPermissions = []; }
});

test("reports an empty product breakdown without treating data warnings as complete", async () => {
  enabled = true; llmError = null; storedPermissions = []; messages = []; reads = []; extraMovementItems = [];
  includeMovementProduct = false;
  try {
    await withServer(async (url) => {
      assert.equal((await post(url, { question: "So sánh cửa hàng", metric: "netRevenue", from: body.from, to: body.to })).status, 201);
      assert.equal((await post(url, { question: "Theo từng sản phẩm", analysis: "comparison_breakdown", level: "product", previousMessageId: messages[1].id })).status, 201);
      assert.equal(messages[3].evidence.total, 0);
      assert.deepEqual(messages[3].evidence.items, []);
      assert.match(messages[3].content, /cảnh báo dữ liệu/);
    });
  } finally { includeMovementProduct = true; }
});

test("breaks down only the selected product into SKUs and rejects missing or incompatible scope", async () => {
  enabled = true; llmError = null; storedPermissions = []; messages = []; reads = []; changedContext = false; extraMovementItems = [];
  llmText = '{"kind":"comparison_breakdown","level":"sku"}';
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const request = { question: "Xem từng mã hàng", analysis: "comparison_breakdown", level: "sku", previousMessageId: "1" };
    assert.equal((await post(url, { ...body, metric: "grossProfit", variantId: undefined })).status, 201);
    const interpretation = await (await post(interpret, { question: request.question, conversationId: id })).json();
    assert.equal(interpretation.hasPreviousComparisonBreakdown, true);
    includeMovementProduct = false;
    try { assert.equal((await post(url, request)).status, 404); }
    finally { includeMovementProduct = true; }
    assert.equal(messages.length, 2);
    assert.equal((await post(url, request)).status, 201);
    const result = messages[3].evidence;
    assert.equal(result.subject.productId, productId);
    assert.equal(result.metric, "grossProfit");
    assert.deepEqual(result.items.map((item) => [item.name, item.current, item.previous, item.difference]), [["SKU", "20.00", "40.00", "-20.00"]]);
    assert.match(messages[3].content, /chưa trừ chi phí vận hành/);
    assert.equal((await post(url, { ...request, previousMessageId: messages[3].id })).status, 400);
    messages = [];
    assert.equal((await post(url, body)).status, 201);
    assert.equal((await (await post(interpret, { question: request.question, conversationId: id })).json()).hasPreviousComparisonBreakdown, false);
    assert.equal((await post(url, request)).status, 400);
  });
});

test("rejects incompatible or malformed prior comparison context rather than guessing scope", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; reads = []; changedContext = false; extraMovementItems = [];
  llmText = '{"kind":"change_comparison_metric","metric":"grossProfit"}';
  await withServer(async (url) => {
    assert.equal((await post(url, body)).status, 201);
    const message = messages[1];
    const evidence = message.evidence;
    const bad = [
      { ...evidence, source: undefined },
      { ...evidence, subject: undefined },
      { ...evidence, subject: { product: "Áo", sku: "SKU" } },
      { ...evidence, subject: { product: "Áo", productId, sku: "SKU" } },
      { ...evidence, ranges: { ...evidence.ranges, previous: { from: "2026-04-12", to: "2026-04-18" } } },
      { ...evidence, ranges: { ...evidence.ranges, current: { from: "2026-02-30", to: "2026-03-08" } } },
      { ...evidence, ranges: { ...evidence.ranges, current: { ...evidence.ranges.current, dayCount: 6 } } },
    ];
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    for (const invalid of bad) {
      message.evidence = invalid;
      const response = await post(interpret, { question: "Còn lợi nhuận gộp?", conversationId: id });
      assert.equal((await response.json()).hasPreviousComparison, false);
      assert.equal((await post(url, { question: "Còn lợi nhuận gộp?", analysis: "change_comparison_metric", metric: "grossProfit", previousMessageId: message.id })).status, 400);
    }
    assert.equal(reads.length, 1);
    assert.equal(messages.length, 2);
    llmText = '{"kind":"clarify_comparison","missing":"metric"}';
    const clarification = await post(interpret, { question: "Còn lợi nhuận thì sao?", conversationId: id });
    assert.match((await clarification.json()).clarification, /doanh thu thuần hay lợi nhuận gộp/);
    assert.equal(reads.length, 1);
  });
});

test("compares the last displayed ranking with the adjacent period, with scoped permissions and context", async () => {
  const previousFlag = process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED;
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; skuQueries = []; changedContext = false;
  llmText = '{"kind":"compare_previous_sku_sales"}';
  const question = "Số bán các mã đó so với kỳ liền trước?";
  try {
    process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "true";
    await withServer(async (url) => {
      const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
      assert.equal((await (await post(interpret, { question })).json()).hasComparableRanking, false);
      assert.equal((await post(url, { question: "Mặt hàng nào bán chạy?", analysis: "top_sellers" })).status, 201);
      const previous = messages[1];
      const context = await (await post(interpret, { question, conversationId: id })).json();
      assert.equal(context.hasComparableRanking, true);
      assert.equal(context.previousMessageId, previous.id);
      assert.deepEqual(JSON.parse(llmRequests.at(-1).input), { question, hasPreviousRanking: true });
      const request = { question, analysis: "compare_previous_sku_sales", previousMessageId: previous.id };
      assert.equal((await post(url, { ...request, previousMessageId: "old" })).status, 409);
      assert.equal((await post(url, request, { "x-business": "business-b" })).status, 404);
      assert.equal((await post(url, request, { "x-permissions": "analytics.read" })).status, 403);
      storedPermissions = [["inventory.read"]];
      assert.equal((await post(url, request)).status, 403);
      storedPermissions = [];
      enabled = false;
      assert.equal((await post(url, request)).status, 403);
      enabled = true;
      process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "false";
      assert.equal((await post(url, request)).status, 503);
      process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "true";
      changedContext = true;
      assert.equal((await post(url, request)).status, 409);
      changedContext = false;
      assert.equal(messages.length, 2);
      assert.equal((await post(url, request)).status, 201);
      assert.deepEqual(messages[3].evidence.items.map(({ variantId, current, previous, difference }) => [variantId, current, previous, difference]), [[variantId, 20, 8, 12]]);
      assert.deepEqual(skuQueries.at(-1), { ...previous.evidence.period, all: "true" });
      assert.equal(messages[3].evidence.followUp.previousMessageId, previous.id);
      llmText = '{"kind":"compare_previous_sku_sales","extra":1}';
      assert.equal((await post(interpret, { question })).status, 502);
      assert.equal(messages.length, 4);
    });
  } finally {
    changedContext = false; storedPermissions = [];
    if (previousFlag === undefined) delete process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED;
    else process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = previousFlag;
  }
});

test("classifies combined restock and expiry and retains action context", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; changedContext = false;
  llmText = '{"kind":"top_sellers_composed","filters":["near_expiry","pending_restock"]}';
  const question = "Mã bán chạy nào cần nhập thêm nhưng có lô sắp hết hạn?";
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const context = await (await post(interpret, { question })).json();
    assert.deepEqual(context.filters, ["pending_restock", "near_expiry"]);
    assert.deepEqual(JSON.parse(llmRequests[0].input), { question, hasPreviousRanking: false });
    const request = { question, analysis: context.kind, filters: context.filters };
    assert.equal((await post(url, request, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, request, { "x-permissions": "analytics.read" })).status, 403);
    assert.equal((await post(url, { ...request, filters: ["pending_restock", "stockout_risk"] })).status, 400);
    assert.equal((await post(url, request)).status, 201);
    const previous = messages[1];
    assert.equal(previous.evidence.type, "top_sellers_restock_near_expiry_v1");
    assert.equal(previous.evidence.items[0].sku, "TEST-SKU");
    assert.equal(previous.evidence.items[0].lots[0].lotNumber, "L1");
    assert.equal(previous.evidence.items[0].suggestedQty, 4);
    llmText = '{"kind":"previous_actions"}';
    const action = await (await post(interpret, { question: "Vậy nên làm gì?", conversationId: id })).json();
    assert.equal(action.hasPreviousActions, true);
    assert.deepEqual(JSON.parse(llmRequests.at(-1).input), { question: "Vậy nên làm gì?", hasPreviousRanking: false });
    assert.equal((await post(url, { question: "Vậy nên làm gì?", analysis: "previous_actions", previousMessageId: previous.id })).status, 201);
    assert.deepEqual(messages[3].evidence.conditions, ["Có gợi ý nhập đang chờ", "Có lô sắp hết hạn"]);
    assert.equal(messages[3].evidence.actions.length, 2);
  });
});

test("classifies and saves ranked restock with overstock and both action contracts", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; changedContext = false;
  llmText = '{"kind":"top_sellers_composed","filters":["overstock","pending_restock"]}';
  const question = "Mã bán chạy nào có gợi ý nhập nhưng đang tồn nhiều?";
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const context = await (await post(interpret, { question })).json();
    assert.deepEqual(context.filters, ["pending_restock", "overstock"]);
    assert.deepEqual(JSON.parse(llmRequests[0].input), { question, hasPreviousRanking: false });
    const request = { question, analysis: context.kind, filters: context.filters };
    assert.equal((await post(url, request, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, request, { "x-permissions": "analytics.read" })).status, 403);
    const previousFlag = process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED;
    try {
      process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "false";
      assert.equal((await post(url, request)).status, 503);
      assert.equal(messages.length, 0);
    } finally {
      if (previousFlag === undefined) delete process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED;
      else process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = previousFlag;
    }
    assert.equal((await post(url, request)).status, 201);
    const previous = messages[1];
    assert.equal(previous.evidence.type, "top_sellers_restock_overstock_v1");
    assert.equal(previous.evidence.items[0].stockAvailable, 100);
    assert.equal(previous.evidence.items[0].suggestedQty, 4);
    llmText = '{"kind":"previous_actions"}';
    const action = await (await post(interpret, { question: "Vậy nên làm gì?", conversationId: id })).json();
    assert.equal(action.hasPreviousActions, true);
    assert.equal((await post(url, { question: "Vậy nên làm gì?", analysis: "previous_actions", previousMessageId: previous.id })).status, 201);
    assert.deepEqual(messages[3].evidence.conditions, ["Có gợi ý nhập đang chờ", "Cảnh báo tồn nhiều"]);
    assert.equal(messages[3].evidence.actions.length, 2);
  });
});

test("classifies and saves ranked restock without sending results to OpenAI", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; changedContext = false;
  llmText = '{"kind":"top_sellers_restock"}';
  const question = "Mã bán chạy nào có gợi ý nhập?";
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const parsed = await (await post(interpret, { question })).json();
    assert.equal(parsed.kind, "top_sellers_restock");
    assert.deepEqual(JSON.parse(llmRequests[0].input), { question, hasPreviousRanking: false });
    assert.equal((await post(url, { question, analysis: parsed.kind }, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, { question, analysis: parsed.kind }, { "x-permissions": "analytics.read" })).status, 403);
    process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "false";
    try { assert.equal((await post(url, { question, analysis: parsed.kind })).status, 503); }
    finally { delete process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED; }
    assert.equal((await post(url, { question, analysis: parsed.kind })).status, 201);
    assert.equal(messages[1].evidence.type, "top_sellers_restock_v1");
    assert.equal(messages[1].evidence.items[0].unitsSold, 20);
    assert.equal(messages[1].evidence.query.filter.condition, "pending_restock");
    llmText = '{"kind":"previous_actions"}';
    const followup = await (await post(interpret, { question: "Vậy nên làm gì?", conversationId: id })).json();
    assert.equal(followup.hasPreviousActions, true);
    assert.equal((await post(url, { question: "Vậy nên làm gì?", analysis: "previous_actions", previousMessageId: followup.previousMessageId })).status, 201);
    assert.equal(messages[3].evidence.conditions[0], "Có gợi ý nhập đang chờ");
  });
});

test("suggests actions only from compatible previous evidence with stable context", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; changedContext = false;
  llmText = '{"kind":"previous_actions"}';
  const question = "Vậy nên làm gì?";
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    assert.equal((await (await post(interpret, { question })).json()).hasPreviousActions, false);
    assert.equal((await post(url, { question: "Hàng bán chạy tồn nhiều?", analysis: "top_sellers_overstock" })).status, 201);
    const previous = messages[1];
    const context = await (await post(interpret, { question, conversationId: id })).json();
    assert.equal(context.hasPreviousActions, true);
    assert.equal(context.previousMessageId, previous.id);
    assert.deepEqual(JSON.parse(llmRequests.at(-1).input), { question, hasPreviousRanking: false });
    const request = { question, analysis: "previous_actions", previousMessageId: previous.id };
    assert.equal((await post(url, { ...request, previousMessageId: "old" })).status, 409);
    assert.equal((await post(url, request, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, request, { "x-permissions": "analytics.read" })).status, 403);
    enabled = false;
    assert.equal((await post(url, request)).status, 403);
    enabled = true;
    changedContext = true;
    assert.equal((await post(url, request)).status, 409);
    changedContext = false;
    const readsBefore = skuReads.length;
    assert.equal((await post(url, request)).status, 201);
    assert.equal(skuReads.length, readsBefore);
    const result = messages.at(-1).evidence;
    assert.deepEqual(result.conditions, ["Cảnh báo tồn nhiều"]);
    assert.equal(result.items[0].sku, "TEST-SKU");
    assert.equal(result.followUp.previousMessageId, previous.id);
    assert.equal((await post(url, { ...request, previousMessageId: messages.at(-1).id })).status, 400);
    llmText = '{"kind":"previous_actions","extra":"untrusted"}';
    assert.equal((await post(interpret, { question })).status, 502);
  });
});

test("answers coverage for the requested displayed SKU with permissions, consent and stable context", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; changedContext = false;
  llmText = '{"kind":"previous_item_cover","position":1}';
  const question = "Mã đầu tiên còn bao nhiêu ngày bán?";
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    assert.equal((await (await post(interpret, { question })).json()).hasPreviousSkuList, false);
    assert.equal((await post(url, { question: "Mặt hàng nào bán chạy?", analysis: "top_sellers" })).status, 201);
    const previous = messages[1];
    const context = await (await post(interpret, { question, conversationId: id })).json();
    assert.equal(context.hasPreviousSkuList, true);
    assert.equal(context.previousMessageId, previous.id);
    assert.deepEqual(JSON.parse(llmRequests.at(-1).input), { question, hasPreviousRanking: true });
    const request = { question, analysis: "previous_item_cover", position: 1, previousMessageId: previous.id };
    assert.equal((await post(url, { ...request, position: 2 })).status, 400);
    assert.equal((await post(url, { ...request, question: "Mã thứ hai còn bao nhiêu ngày bán?", position: 2 })).status, 400);
    assert.equal((await post(url, { ...request, previousMessageId: "old" })).status, 409);
    assert.equal((await post(url, request, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, request, { "x-permissions": "analytics.read" })).status, 403);
    storedPermissions = [["inventory.read"]];
    assert.equal((await post(url, request)).status, 403);
    storedPermissions = [];
    enabled = false; assert.equal((await post(url, request)).status, 403); enabled = true;
    changedContext = true; assert.equal((await post(url, request)).status, 409); changedContext = false;
    assert.equal(messages.length, 2);
    assert.equal((await post(url, request)).status, 201);
    const result = messages[3].evidence;
    assert.equal(result.item.variantId, variantId);
    assert.equal(result.daysOfCover, 90);
    assert.equal(result.stockAvailable, 100);
    assert.equal(result.state, "partial");
    assert.equal(result.followUp.previousMessageId, previous.id);
    for (const output of ['{"kind":"previous_item_cover"}', '{"kind":"previous_item_cover","position":0}', '{"kind":"previous_item_cover","position":1,"extra":1}']) {
      llmText = output;
      assert.equal((await post(interpret, { question })).status, 502);
    }
    llmText = '{"kind":"previous_item_cover","position":2}';
    assert.equal((await post(interpret, { question })).status, 400);
  });
});

test("ranking and follow-up are scoped and the classifier never receives results", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; changedContext = false;
  llmText = '{"kind":"top_sellers"}';
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const first = await post(interpret, { question: "Mặt hàng nào bán chạy?" });
    assert.deepEqual(await first.json(), { kind: "top_sellers", hasPreviousRanking: false, hasPreviousSkuList: false });
    assert.equal((await post(url, { question: "Mặt hàng nào bán chạy?", analysis: "top_sellers" })).status, 201);
    assert.equal(messages[1].evidence.items[0].sku, "TEST-SKU");
    assert.equal(messages[1].evidence.analysis, "top_sellers");
    llmText = '{"kind":"previous_stockout"}';
    const followup = await post(interpret, { question: "Trong số đó có mặt hàng nào sắp hết?", conversationId: id });
    assert.deepEqual(await followup.json(), { kind: "previous_stockout", hasPreviousRanking: true, hasPreviousSkuList: true, previousMessageId: messages[1].id });
    assert.deepEqual(JSON.parse(llmRequests[1].input), { question: "Trong số đó có mặt hàng nào sắp hết?", hasPreviousRanking: true });
    assert.equal((await post(url, { question: "Trong số đó có mặt hàng nào sắp hết?", analysis: "previous_stockout", previousMessageId: messages[1].id })).status, 201);
    assert.equal(messages[3].evidence.items[0].severity, "HIGH");
    assert.equal(messages[3].evidence.analysis, "previous_stockout");
    assert.deepEqual(skuReads, ["business-a", "business-a"]);
    assert.equal((await post(url, { question: "Mặt hàng nào bán chạy?", analysis: "top_sellers" }, { "x-business": "business-b" })).status, 404);
    assert.equal(llmRequests.length, 2);
  });
});

test("saves the compiled query and can return to the existing path without changing answers", async () => {
  const previousFlag = process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED;
  enabled = true; llmRequests = []; storedPermissions = []; messages = []; skuReads = [];
  try {
    await withServer(async (url) => {
      process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "true";
      const request = { question: "Mặt hàng nào bán chạy?", analysis: "top_sellers", query: { rank: { limit: 500 } } };
      assert.equal((await post(url, request)).status, 201);
      const composed = messages[1].evidence;
      assert.equal(composed.query.version, 1);
      assert.equal(composed.query.rank.limit, 5);
      assert.deepEqual(composed.query.rank.period, composed.period);
      assert.equal(composed.query.filter, null);
      assert.equal(llmRequests.length, 0);

      process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "false";
      assert.equal((await post(url, request)).status, 201);
      const { query, ...composedEvidence } = composed;
      assert.deepEqual(composedEvidence, messages[3].evidence);
      assert.equal(messages[3].evidence.query, undefined);
      assert.equal(messages[1].content, messages[3].content);

      process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "invalid";
      assert.equal((await post(url, request)).status, 500);
      assert.equal(messages.length, 4);
    });
  } finally {
    if (previousFlag === undefined) delete process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED;
    else process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = previousFlag;
  }
});
    test("validates and answers composed requests without sending business results to OpenAI", async () => {
      const previousFlag = process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED;
      enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = [];
      const question = "Mã bán chạy nào vừa tồn nhiều vừa sắp hết hạn?";
      try {
        process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "true";
        await withServer(async (url) => {
          const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
          llmText = '{"kind":"top_sellers_composed","filters":["near_expiry","overstock"]}';
          const classified = await post(interpret, { question });
          assert.equal(classified.status, 200);
          assert.deepEqual((await classified.json()).filters, ["overstock", "near_expiry"]);
          assert.deepEqual(JSON.parse(llmRequests[0].input), { question, hasPreviousRanking: false });
          for (const filters of [undefined, ["overstock"], ["overstock", "overstock"], ["overstock", "near_expiry", "other"]]) {
            assert.equal((await post(url, { question, analysis: "top_sellers_composed", filters })).status, 400);
          }
          const request = { question, analysis: "top_sellers_composed", filters: ["near_expiry", "overstock"], query: { rank: { limit: 500 } } };
          assert.equal((await post(url, request, { "x-business": "business-b" })).status, 404);
          assert.equal((await post(url, request, { "x-permissions": "analytics.read" })).status, 403);
          assert.equal(messages.length, 0);
          assert.equal((await post(url, request)).status, 201);
          assert.equal(messages[1].evidence.type, "top_sellers_overstock_near_expiry_v1");
          assert.equal(messages[1].evidence.query.rank.limit, 5);
          assert.equal(messages[1].evidence.items[0].sku, "TEST-SKU");
          assert.deepEqual(skuReads, ["business-a", "business-a"]);
          llmText = '{"kind":"previous_restock"}';
          const followup = await post(interpret, { question: "Trong số đó mã nào cần nhập?", conversationId: id });
          const context = await followup.json();
          assert.equal(context.hasPreviousSkuList, true);
          assert.deepEqual(JSON.parse(llmRequests[1].input), { question: "Trong số đó mã nào cần nhập?", hasPreviousRanking: false });
          assert.equal((await post(url, { question: "Trong số đó mã nào cần nhập?", analysis: "previous_restock", previousMessageId: context.previousMessageId })).status, 201);
          assert.equal(messages[3].evidence.sourceInventoryCaution, true);
          assert.equal(messages[3].evidence.items[0].variantId, variantId);
          assert.equal(llmRequests.length, 2);
          process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "false";
          assert.equal((await post(url, request)).status, 503);
          assert.equal(messages.length, 4);
          for (const output of [
            '{"kind":"top_sellers_composed"}',
            '{"kind":"top_sellers_composed","filters":["overstock","overstock"]}',
            '{"kind":"top_sellers_composed","filters":["overstock","near_expiry"],"extra":1}',
          ]) {
            llmText = output;
            assert.equal((await post(interpret, { question })).status, 502);
          }
        });
      } finally {
        if (previousFlag === undefined) delete process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED;
        else process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = previousFlag;
      }
    });
test("filters the previous displayed list for near-expiry lots without sending it to OpenAI", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; changedContext = false;
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const question = "Trong số đó có mã nào có lô sắp hết hạn?";
    llmText = '{"kind":"previous_near_expiry"}';
    const first = await post(interpret, { question });
    assert.equal((await first.json()).hasPreviousSkuList, false);
    assert.equal((await post(url, { question, analysis: "previous_near_expiry" })).status, 400);
    assert.equal((await post(url, { question: "Bán chạy?", analysis: "top_sellers" })).status, 201);
    const classified = await post(interpret, { question, conversationId: id });
    const context = await classified.json();
    assert.equal(context.hasPreviousSkuList, true);
    assert.deepEqual(JSON.parse(llmRequests[1].input), { question, hasPreviousRanking: true });
    const request = { question, analysis: "previous_near_expiry", previousMessageId: context.previousMessageId };
    assert.equal((await post(url, request, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, request, { "x-permissions": "analytics.read" })).status, 403);
    assert.equal((await post(url, { ...request, previousMessageId: "other" })).status, 409);
    changedContext = true;
    assert.equal((await post(url, request)).status, 409);
    changedContext = false;
    assert.equal((await post(url, request)).status, 201);
    assert.equal(messages[3].evidence.type, "previous_near_expiry_v1");
    assert.equal(messages[3].evidence.items[0].sku, "TEST-SKU");
    assert.equal(llmRequests.length, 2);
    assert.equal((await post(url, { question: "Mã nào cần nhập?", analysis: "previous_restock", previousMessageId: messages[3].id })).status, 201);
    assert.equal(messages[5].evidence.sourceInventoryCaution, true);
  });
});

test("changes a saved SKU query period without sharing context and rejects stale or invalid requests", async () => {
  const flag = process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED;
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; skuQueries = []; changedContext = false;
  try {
    process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "true";
    await withServer(async (url) => {
      const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
      llmText = '{"kind":"change_sku_period","periodChange":"last_week"}';
      const missing = await post(interpret, { question: "Cùng câu đó tuần trước?" });
      assert.equal((await missing.json()).hasPreviousSkuQuery, false);
      assert.equal((await post(url, { question: "Cùng câu đó tuần trước?", analysis: "change_sku_period", periodChange: "last_week" })).status, 400);
      assert.equal((await post(url, { question: "Bán chạy và tồn nhiều?", analysis: "top_sellers_overstock" })).status, 201);
      const old = messages[1];
      const response = await post(interpret, { question: "Cùng câu đó tuần trước?", conversationId: id });
      const result = await response.json();
      assert.equal(result.hasPreviousSkuQuery, true);
      assert.equal(result.previousMessageId, old.id);
      assert.deepEqual(JSON.parse(llmRequests[1].input), { question: "Cùng câu đó tuần trước?", hasPreviousRanking: false });
      const request = { question: "Cùng câu đó tuần trước?", analysis: "change_sku_period", periodChange: "last_week", previousMessageId: old.id };
      assert.equal((await post(url, { ...request, periodChange: "month" })).status, 400);
      assert.equal((await post(url, { ...request, previousMessageId: "other" })).status, 409);
      assert.equal((await post(url, request, { "x-business": "business-b" })).status, 404);
      assert.equal((await post(url, request, { "x-permissions": "analytics.read" })).status, 403);
      changedContext = true;
      assert.equal((await post(url, request)).status, 409);
      changedContext = false;
      assert.equal((await post(url, request)).status, 201);
      assert.equal(messages[3].evidence.analysis, "top_sellers_overstock");
      assert.equal(messages[3].evidence.followUp.previousMessageId, old.id);
      assert.equal(messages[3].evidence.query.filter.condition, "overstock");
      assert.deepEqual(skuQueries.at(-1), { ...messages[3].evidence.period, all: "true" });
      assert.equal(llmRequests.length, 2);
      process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = "false";
      assert.equal((await post(url, { ...request, previousMessageId: messages[3].id })).status, 503);
      for (const output of [
        '{"kind":"change_sku_period"}',
        '{"kind":"change_sku_period","periodChange":"future"}',
        '{"kind":"change_sku_period","periodChange":"last_week","extra":1}',
      ]) {
        llmText = output;
        assert.equal((await post(interpret, { question: request.question })).status, 502);
      }
    });
  } finally {
    changedContext = false;
    if (flag === undefined) delete process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED;
    else process.env.ASSISTANT_COMPOSABLE_SKU_ENABLED = flag;
  }
});

test("slow-expiry classification and answer do not send business results to OpenAI", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = [];
  llmText = '{"kind":"slow_moving_expiry"}';
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const question = "Mặt hàng nào bán chậm và có nguy cơ hết hạn?";
    const response = await post(interpret, { question });
    assert.deepEqual(await response.json(), { kind: "slow_moving_expiry", hasPreviousRanking: false, hasPreviousSkuList: false });
    assert.deepEqual(JSON.parse(llmRequests[0].input), { question, hasPreviousRanking: false });
    assert.equal((await post(url, { question, analysis: "slow_moving_expiry" }, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, { question, analysis: "slow_moving_expiry" }, { "x-permissions": "analytics.read" })).status, 403);
    assert.equal((await post(url, { question, analysis: "slow_moving_expiry" })).status, 201);
    assert.equal(messages[1].evidence.items[0].lots[0].status, "expired");
    assert.deepEqual(skuReads, ["business-a"]);
    assert.equal(llmRequests.length, 1);
  });
});

test("profit and restock flow is scoped and does not send results to OpenAI", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = [];
  llmText = '{"kind":"profit_restock"}';
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const question = "Mã hàng nào có lợi nhuận cao và cần nhập thêm?";
    assert.deepEqual(await (await post(interpret, { question })).json(), { kind: "profit_restock", hasPreviousRanking: false, hasPreviousSkuList: false });
    assert.deepEqual(JSON.parse(llmRequests[0].input), { question, hasPreviousRanking: false });
    assert.equal((await post(url, { question, analysis: "profit_restock" }, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, { question, analysis: "profit_restock" }, { "x-permissions": "analytics.read" })).status, 403);
    assert.equal((await post(url, { question, analysis: "profit_restock" })).status, 201);
    assert.equal(messages[1].evidence.items[0].grossProfit, "123.00");
    assert.equal(messages[1].evidence.items[0].suggestedQty, 4);
    assert.deepEqual(skuReads, ["business-a", "business-a"]);
    assert.equal(llmRequests.length, 1);
  });
});

test("overstock forecast flow is scoped and sends only the question to OpenAI", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = [];
  llmText = '{"kind":"overstock_forecast"}';
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const question = "Mã nào tồn nhiều và nhu cầu dự báo giảm?";
    assert.deepEqual(await (await post(interpret, { question })).json(), { kind: "overstock_forecast", hasPreviousRanking: false, hasPreviousSkuList: false });
    assert.deepEqual(JSON.parse(llmRequests[0].input), { question, hasPreviousRanking: false });
    assert.equal((await post(url, { question, analysis: "overstock_forecast" }, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, { question, analysis: "overstock_forecast" }, { "x-permissions": "analytics.read" })).status, 403);
    assert.equal((await post(url, { question, analysis: "overstock_forecast" })).status, 201);
    assert.equal(messages[1].evidence.items[0].sold30, 30);
    assert.equal(messages[1].evidence.items[0].forecast7, 3);
    assert.deepEqual(skuReads, ["business-a"]);
    assert.equal(llmRequests.length, 1);
  });
});

test("top sellers with overstock classifies without sharing results and remains tenant-scoped", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = [];
  llmText = '{"kind":"top_sellers_overstock"}';
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const question = "Mã nào bán chạy mà tồn nhiều?";
    const response = await (await post(interpret, { question })).json();
    assert.equal(response.kind, "top_sellers_overstock");
    assert.deepEqual(JSON.parse(llmRequests[0].input), { question, hasPreviousRanking: false });
    assert.equal((await post(url, { question, analysis: response.kind }, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, { question, analysis: response.kind }, { "x-permissions": "analytics.read" })).status, 403);
    assert.equal((await post(url, { question, analysis: response.kind })).status, 201);
    assert.equal(messages[1].evidence.type, "top_sellers_overstock_v1");
    assert.equal(llmRequests.length, 1);
    llmText = '{"kind":"top_sellers_near_expiry"}';
    const nearExpiryQuestion = "Mã bán chạy nào có lô sắp hết hạn?";
    assert.equal((await (await post(interpret, { question: nearExpiryQuestion })).json()).kind, "top_sellers_near_expiry");
    assert.deepEqual(JSON.parse(llmRequests[1].input), { question: nearExpiryQuestion, hasPreviousRanking: false });
  });
});

test("follow-up rejects missing, revoked or concurrently changed context", async () => {
  enabled = true; storedPermissions = []; messages = []; changedContext = false;
  await withServer(async (url) => {
    const body = { question: "Trong số đó có mặt hàng nào sắp hết?", analysis: "previous_stockout", previousMessageId: "old" };
    assert.equal((await post(url, { ...body, previousMessageId: undefined })).status, 400);
    assert.equal(messages.length, 0);
    assert.equal((await post(url, { question: "Mặt hàng nào bán chạy?", analysis: "top_sellers" })).status, 201);
    assert.equal((await post(url, body)).status, 409);
    assert.equal((await post(url, { ...body, previousMessageId: undefined })).status, 400);
    body.previousMessageId = messages[1].id;
    storedPermissions = [["extra.permission"]];
    assert.equal((await post(url, body)).status, 403);
    storedPermissions = [];
    changedContext = true;
    assert.equal((await post(url, body)).status, 409);
    assert.equal(messages.length, 2);
    changedContext = false;
  });
});

test("previous restock uses the latest displayed list, checks context and sends no SKU to OpenAI", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; changedContext = false;
  await withServer(async (url) => {
    assert.equal((await post(url, { question: "Mặt hàng nào bán chạy?", analysis: "top_sellers" })).status, 201);
    const previousMessageId = messages[1].id;
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const question = "Trong số đó mã nào cần ưu tiên nhập?";
    llmText = '{"kind":"previous_restock"}';
    const parsed = await (await post(interpret, { question, conversationId: id })).json();
    assert.deepEqual(parsed, { kind: "previous_restock", hasPreviousRanking: true, hasPreviousSkuList: true, previousMessageId });
    assert.deepEqual(JSON.parse(llmRequests[0].input), { question, hasPreviousRanking: true });
    assert.equal((await post(url, { question, analysis: "previous_restock" })).status, 400);
    assert.equal((await post(url, { question, analysis: "previous_restock", previousMessageId: "old" })).status, 409);
    assert.equal((await post(url, { question, analysis: "previous_restock", previousMessageId }, { "x-business": "business-b" })).status, 404);
    assert.equal((await post(url, { question, analysis: "previous_restock", previousMessageId }, { "x-permissions": "analytics.read" })).status, 403);
    storedPermissions = [["extra.permission"]];
    assert.equal((await post(url, { question, analysis: "previous_restock", previousMessageId })).status, 403);
    storedPermissions = [];
    changedContext = true;
    assert.equal((await post(url, { question, analysis: "previous_restock", previousMessageId })).status, 409);
    assert.equal(messages.length, 2);
    changedContext = false;
    assert.equal((await post(url, { question, analysis: "previous_restock", previousMessageId })).status, 201);
    assert.equal(messages[3].evidence.items[0].sku, "TEST-SKU");
    assert.deepEqual(messages[3].evidence.items[0].cautions, ["SLOW_MOVING", "EXPIRATION_RISK", "OVERSTOCK"]);
    assert.equal(llmRequests.length, 1);
    assert.equal((await post(url, { question: "Hàng bán chậm và sắp hết hạn?", analysis: "slow_moving_expiry" })).status, 201);
    const inventoryId = messages[5].id;
    const inventoryFollowup = await (await post(interpret, { question, conversationId: id })).json();
    assert.deepEqual(inventoryFollowup, { kind: "previous_restock", hasPreviousRanking: false, hasPreviousSkuList: true, previousMessageId: inventoryId });
    assert.deepEqual(JSON.parse(llmRequests[1].input), { question, hasPreviousRanking: false });
    assert.equal((await post(url, { question, analysis: "previous_restock", previousMessageId: inventoryId })).status, 201);
    assert.equal(messages[7].evidence.sourceInventoryCaution, true);
  });
});

test("filters the previous displayed list for overstock and can continue into scoped actions", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; changedContext = false;
  await withServer(async (url) => {
    assert.equal((await post(url, { question: "Mặt hàng nào bán chạy?", analysis: "top_sellers" })).status, 201);
    const previousMessageId = messages[1].id;
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const question = "Trong số đó mã nào tồn nhiều?";
    llmText = '{"kind":"previous_overstock"}';
    const parsed = await (await post(interpret, { question, conversationId: id })).json();
    assert.deepEqual(parsed, {
      kind: "previous_overstock", hasPreviousRanking: true, hasPreviousSkuList: true, previousMessageId,
    });
    assert.deepEqual(JSON.parse(llmRequests[0].input), { question, hasPreviousRanking: true });
    assert.equal((await post(url, { question, analysis: "previous_overstock" })).status, 400);
    assert.equal((await post(url, { question, analysis: "previous_overstock", previousMessageId })).status, 201);
    assert.equal(messages[3].evidence.type, "previous_overstock_v1");
    assert.deepEqual(messages[3].evidence.items.map(({ variantId, stockAvailable }) => [variantId, stockAvailable]), [[variantId, 100]]);
    assert.equal(messages[3].evidence.sourceCount, 1);
    assert.equal(messages[3].evidence.totalSku, 1);

    llmText = '{"kind":"previous_actions"}';
    const actions = await (await post(interpret, { question: "Vậy nên làm gì?", conversationId: id })).json();
    assert.equal(actions.hasPreviousActions, true);
    assert.equal(actions.previousMessageId, messages[3].id);
    assert.deepEqual(JSON.parse(llmRequests[1].input), { question: "Vậy nên làm gì?", hasPreviousRanking: false });
    assert.equal((await post(url, {
      question: "Vậy nên làm gì?", analysis: "previous_actions", previousMessageId: actions.previousMessageId,
    })).status, 201);
    assert.deepEqual(messages[5].evidence.conditions, ["Cảnh báo tồn nhiều"]);
    assert.equal(llmRequests.length, 2);
  });
});

test("keeps the displayed SKU and context across a three-turn synthetic conversation", async () => {
  enabled = true; llmRequests = []; llmError = null; storedPermissions = []; messages = []; skuReads = []; changedContext = false;
  await withServer(async (url) => {
    const interpret = url.replace(`/conversations/${id}/messages`, "/interpret");
    const first = "Những mã hàng nào bán chạy gần đây?";
    llmText = '{"kind":"top_sellers"}';
    const ranking = await (await post(interpret, { question: first })).json();
    assert.equal((await post(url, { question: first, analysis: ranking.kind })).status, 201);

    const second = "Trong các mã vừa xem, mã nào có gợi ý nhập?";
    llmText = '{"kind":"previous_restock"}';
    const restock = await (await post(interpret, { question: second, conversationId: id })).json();
    assert.equal(restock.previousMessageId, messages[1].id);
    assert.equal((await post(url, { question: second, analysis: restock.kind, previousMessageId: restock.previousMessageId })).status, 201);

    const third = "Vậy nên làm gì?";
    llmText = '{"kind":"previous_actions"}';
    const actions = await (await post(interpret, { question: third, conversationId: id })).json();
    assert.equal(actions.previousMessageId, messages[3].id);
    assert.equal(actions.hasPreviousActions, true);
    assert.equal((await post(url, { question: third, analysis: actions.kind, previousMessageId: actions.previousMessageId })).status, 201);
    assert.deepEqual(messages[5].evidence.items.map((item) => item.variantId), [variantId]);
    assert.deepEqual(llmRequests.map((request) => JSON.parse(request.input)), [
      { question: first, hasPreviousRanking: false },
      { question: second, hasPreviousRanking: true },
      { question: third, hasPreviousRanking: false },
    ]);
  });
});

test("only an active owner can change business consent", async () => {
  enabled = false;
  await withServer(async (url) => {
    const settings = url.replace(`/conversations/${id}/messages`, "/openai-consent");
    const put = (value, user) => fetch(settings, {
      method: "PUT", headers: { "content-type": "application/json", "x-user": user, "x-test-role": "OWNER" },
      body: JSON.stringify({ enabled: value }),
    });
    assert.equal((await put(true, "user-a")).status, 403);
    assert.equal(enabled, false);
    assert.equal((await put("true", "owner")).status, 400);
    assert.equal((await put(true, "owner")).status, 200);
    assert.deepEqual(await (await fetch(settings)).json(), { enabled: true });
    assert.equal((await put(false, "owner")).status, 200);
    assert.equal(enabled, false);
  });
});
