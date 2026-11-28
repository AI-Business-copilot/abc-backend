const { isDeepStrictEqual } = require("node:util");
require("ts-node/register/transpile-only");

const { parseQuestionInterpretation } = require("../src/modules/assistant/question.service");

function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error("The evaluation set must not be empty.");
  const ids = new Set();
  const expectedContextFields = new Set(["hasPreviousSkuList", "hasPreviousSkuQuery", "hasPreviousComparison",
    "hasPreviousComparisonBreakdown", "hasComparableRanking", "hasPreviousActions"]);
  for (const item of cases) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) ||
        typeof item.group !== "string" || !item.group || typeof item.question !== "string" || !item.question ||
        typeof item.hasPreviousRanking !== "boolean" || !item.expected ||
        typeof item.expected !== "object" || Array.isArray(item.expected) || typeof item.expected.kind !== "string" ||
        (item.expectedContext !== undefined && (!item.expectedContext || typeof item.expectedContext !== "object" ||
          Array.isArray(item.expectedContext) || Object.entries(item.expectedContext).some(([key, value]) =>
            !expectedContextFields.has(key) || typeof value !== "boolean")))) {
      throw new Error("Invalid or duplicate evaluation case.");
    }
    ids.add(item.id);
  }
  return ids;
}

function validateResponses(responses, ids) {
  if (!Array.isArray(responses)) throw new Error("Responses must be an array of {id, text} or {id, interpretation} objects.");
  const byId = new Map();
  for (const response of responses) {
    if (!response || typeof response !== "object" || Array.isArray(response) ||
        Object.keys(response).length !== 2 || typeof response.id !== "string" ||
        !(typeof response.text === "string" || (response.interpretation && typeof response.interpretation === "object" &&
          !Array.isArray(response.interpretation))) || !ids.has(response.id) || byId.has(response.id)) {
      throw new Error("A response has an unknown or duplicate ID or an invalid shape.");
    }
    byId.set(response.id, response);
  }
  return byId;
}

function emptyCounts() {
  return { total: 0, correct: 0, incorrect: 0, rejected: 0, missing: 0 };
}

function summarizeCounts(counts) {
  return {
    ...counts,
    accuracy: counts.total === 0 ? null : counts.correct / counts.total,
  };
}

async function evaluate(cases, responses) {
  const ids = validateCases(cases);
  const byId = validateResponses(responses, ids);
  const totals = emptyCounts();
  const groups = {};
  const failures = [];
  const unsupportedOrClarify = { cases: 0, incorrect: 0, unsafeAcceptance: 0 };
  const compositions = { cases: 0, incorrect: 0, alteredConditions: 0 };
  const context = { checked: 0, incorrect: 0, unscored: 0 };
  let wrongKind = 0;
  let wrongParameters = 0;
  const contextFields = new Set(["hasPreviousRanking", "hasPreviousSkuList", "hasPreviousSkuQuery",
    "hasPreviousComparison", "hasPreviousComparisonBreakdown", "hasComparableRanking", "hasPreviousActions", "previousMessageId"]);

  for (const item of cases) {
    const counts = groups[item.group] ?? (groups[item.group] = emptyCounts());
    totals.total++; counts.total++;
    const shouldDecline = item.expected.kind === "unsupported" || item.expected.kind === "clarify_comparison";
    const isComposition = item.expected.kind === "top_sellers_composed";
    if (shouldDecline) unsupportedOrClarify.cases++;
    if (isComposition) compositions.cases++;
    if (item.previous) context.unscored++;

    if (!byId.has(item.id)) {
      totals.missing++; counts.missing++;
      if (shouldDecline) unsupportedOrClarify.incorrect++;
      if (isComposition) compositions.incorrect++;
      failures.push({ id: item.id, group: item.group, outcome: "missing" });
      continue;
    }
    let actual;
    let contextMatches = true;
    let contextMismatches = [];
    try {
      const response = byId.get(item.id);
      if (typeof response.text === "string") {
        actual = parseQuestionInterpretation(item.question, response.text);
      } else {
        actual = Object.fromEntries(Object.entries(response.interpretation).filter(([key]) => !contextFields.has(key)));
        const expectedContext = { hasPreviousRanking: item.hasPreviousRanking, ...(item.expectedContext || {}) };
        context.checked++;
        contextMismatches = Object.entries(expectedContext)
          .filter(([key, value]) => response.interpretation[key] !== value)
          .map(([key]) => key);
        contextMatches = contextMismatches.length === 0;
      }
    } catch (error) {
      if (!error || typeof error.statusCode !== "number") throw error;
      totals.rejected++; counts.rejected++;
      if (shouldDecline) unsupportedOrClarify.incorrect++;
      if (isComposition) compositions.incorrect++;
      failures.push({ id: item.id, group: item.group, outcome: "rejected", statusCode: error.statusCode });
      continue;
    }
    if (isDeepStrictEqual(actual, item.expected) && contextMatches) {
      totals.correct++; counts.correct++;
      continue;
    }
    totals.incorrect++; counts.incorrect++;
    if (!isDeepStrictEqual(actual, item.expected)) {
      if (actual.kind === item.expected.kind) wrongParameters++;
      else wrongKind++;
    }
    if (contextMismatches.length) context.incorrect++;
    if (shouldDecline) {
      unsupportedOrClarify.incorrect++;
      if (actual.kind !== "unsupported" && actual.kind !== "clarify_comparison") unsupportedOrClarify.unsafeAcceptance++;
    }
    if (isComposition) {
      compositions.incorrect++;
      if (actual.kind !== "unsupported" && actual.kind !== "clarify_comparison" &&
          !isDeepStrictEqual(actual, item.expected)) compositions.alteredConditions++;
    }
    failures.push({ id: item.id, group: item.group, outcome: "incorrect", expected: item.expected, actual,
      ...(contextMismatches.length ? { contextMismatches } : {}) });
  }
  return {
    totals: summarizeCounts(totals),
    groups: Object.fromEntries(Object.entries(groups).map(([group, counts]) => [group, summarizeCounts(counts)])),
    risks: { unsupportedOrClarify, compositions, wrongKind, wrongParameters },
    context,
    failures,
  };
}

module.exports = { evaluate };
