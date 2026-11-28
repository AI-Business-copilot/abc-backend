const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const cases = require("../tests/fixtures/assistant-classifier-cases.cjs");
const { evaluate } = require("./assistant-classifier-evaluation.cjs");

async function main() {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts\\evaluate-assistant-classifier.cjs <responses.json>");
  const responses = JSON.parse(readFileSync(resolve(process.argv[2]), "utf8"));
  const report = await evaluate(cases, responses);
  console.log(JSON.stringify(report, null, 2));
  if (report.totals.incorrect || report.totals.rejected || report.totals.missing) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Evaluation failed: ${error.message}`);
  process.exitCode = 1;
});
