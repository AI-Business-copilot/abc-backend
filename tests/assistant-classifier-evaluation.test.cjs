const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const cases = require("./fixtures/assistant-classifier-cases.cjs");
const { evaluate } = require("../scripts/assistant-classifier-evaluation.cjs");

test("scores classifier responses through the real parser and distinguishes dangerous errors", async () => {
  const sample = cases.filter((item) => ["pair-3", "unsupported-3", "comparison-1", "follow-item-2", "rank-1"].includes(item.id));
  const report = await evaluate(sample, [
    { id: "pair-3", text: '{"kind":"top_sellers_restock"}' },
    { id: "unsupported-3", text: '{"kind":"top_sellers_composed","filters":["overstock","near_expiry"]}' },
    { id: "comparison-1", text: '{"kind":"comparison","metric":"netRevenue","period":"dates","from":"2024-02-01","to":"2024-02-29","subjectType":"store"}' },
    { id: "follow-item-2", text: '{"kind":"previous_item_cover","position":1}' },
  ]);
  assert.deepEqual(report.totals, { total: 5, correct: 1, incorrect: 2, rejected: 1, missing: 1, accuracy: 0.2 });
  assert.deepEqual(report.risks.unsupportedOrClarify, { cases: 1, incorrect: 1, unsafeAcceptance: 1 });
  assert.deepEqual(report.risks.compositions, { cases: 1, incorrect: 1, alteredConditions: 1 });
  assert.equal(report.context.unscored, 1);
  assert.equal(report.failures.find((entry) => entry.id === "follow-item-2").statusCode, 400);
});

test("normalizes filter order but rejects malformed, duplicate or unknown responses", async () => {
  const sample = cases.filter((item) => item.id === "pair-5" || item.id === "rank-2");
  const report = await evaluate(sample, [
    { id: "pair-5", text: '{"kind":"top_sellers_composed","filters":["overstock","pending_restock"]}' },
    { id: "rank-2", text: '{"kind":"top_sellers","extra":true}' },
  ]);
  assert.deepEqual(report.totals, { total: 2, correct: 1, incorrect: 0, rejected: 1, missing: 0, accuracy: 0.5 });
  await assert.rejects(evaluate(sample, [{ id: "unknown", text: "{}" }]), /unknown or duplicate/);
  await assert.rejects(evaluate(sample, [{ id: "pair-5", text: "{}" }, { id: "pair-5", text: "{}" }]), /unknown or duplicate/);
});

test("scores the interpretation endpoint response without confusing its context flags with the answer", async () => {
  const sample = cases.filter((item) => item.id === "follow-period-1" || item.id === "comparison-1");
  const report = await evaluate(sample, [
    { id: "follow-period-1", interpretation: {
      kind: "change_sku_period", periodChange: "last_week", hasPreviousRanking: true,
      hasPreviousSkuList: true, hasPreviousSkuQuery: true, previousMessageId: "synthetic",
    } },
    { id: "comparison-1", interpretation: {
      kind: "comparison", comparison: { metric: "netRevenue", from: "2024-02-02", to: "2024-02-29", subjectType: "store" },
      hasPreviousRanking: false, hasPreviousSkuList: false,
    } },
  ]);
  assert.equal(report.totals.correct, 1);
  assert.equal(report.risks.wrongParameters, 1);
  assert.deepEqual(report.context, { checked: 2, incorrect: 0, unscored: 1 });
  assert.equal(report.failures[0].id, "comparison-1");
});

test("counts endpoint context mismatches as evaluation failures", async () => {
  const sample = cases.filter((item) => item.id === "rank-1");
  const report = await evaluate(sample, [
    { id: "rank-1", interpretation: { kind: "top_sellers", hasPreviousRanking: true, hasPreviousSkuList: false } },
  ]);
  assert.equal(report.totals.correct, 0);
  assert.equal(report.context.checked, 1);
  assert.equal(report.context.incorrect, 1);
  assert.deepEqual(report.failures[0].contextMismatches, ["hasPreviousRanking"]);
  assert.equal(report.risks.wrongKind, 0);
  assert.equal(report.risks.wrongParameters, 0);
});

test("scores declared follow-up context flags and includes missing or rejected cases in risk denominators", async () => {
  const contextualCase = {
    ...cases.find((item) => item.id === "follow-period-1"),
    expectedContext: { hasPreviousSkuList: true, hasPreviousSkuQuery: true },
  };
  const unsupportedCases = cases.filter((item) => item.id === "unsupported-1" || item.id === "unsupported-2");
  const report = await evaluate([contextualCase, ...unsupportedCases], [
    { id: contextualCase.id, interpretation: {
      kind: "change_sku_period", periodChange: "last_week", hasPreviousRanking: true,
      hasPreviousSkuList: true, hasPreviousSkuQuery: false,
    } },
    { id: "unsupported-2", text: '{"kind":"top_sellers"}' },
  ]);
  assert.equal(report.context.checked, 1);
  assert.equal(report.context.incorrect, 1);
  assert.deepEqual(report.failures[0].contextMismatches, ["hasPreviousSkuQuery"]);
  assert.deepEqual(report.risks.unsupportedOrClarify, { cases: 2, incorrect: 2, unsafeAcceptance: 1 });
});

test("the evaluation command reports incomplete runs as failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "assistant-evaluation-"));
  const file = join(directory, "responses.json");
  try {
    writeFileSync(file, JSON.stringify([{ id: "rank-1", text: '{"kind":"top_sellers"}' }]));
    const result = spawnSync(process.execPath, [join(__dirname, "../scripts/evaluate-assistant-classifier.cjs"), file], { encoding: "utf8" });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.totals.correct, 1);
    assert.equal(report.totals.missing, cases.length - 1);
  } finally {
    unlinkSync(file);
    rmdirSync(directory);
  }
});
