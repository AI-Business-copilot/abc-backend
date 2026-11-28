const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

const syntheticPath = path.resolve(__dirname, "../../abc-ml/synthetic.py");
const pythonSource = [
  "import importlib.util, json, sys",
  "from datetime import date",
  "spec = importlib.util.spec_from_file_location('synthetic', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "dataset = module.generate(42, 6, 120, date(2025, 1, 1))",
  "print(json.dumps(dataset, separators=(',', ':')))",
].join("\n");
const dataset = JSON.parse(execFileSync(process.env.PYTHON || "python", ["-c", pythonSource, syntheticPath], {
  encoding: "utf8", timeout: 10_000,
}));
const variants = dataset.variants;
const ids = variants.map((_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const variantIdBySyntheticId = new Map(variants.map((variant, index) => [variant.variant_id, ids[index]]));
const prisma = {};
const databasePath = require.resolve("../src/shared/infrastructure/database/prisma.client");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { prisma } };

function sum(rows, project) {
  return rows.reduce((total, row) => total + project(row), 0);
}

function rowsFor(variant, project) {
  return variant.days.map((row) => ({ variantId: variantIdBySyntheticId.get(variant.variant_id), ...project(row) }));
}

function installSyntheticSnapshotQueries() {
  prisma.$queryRaw = async function (strings) {
    const sql = strings.join(" ");
    if (sql.includes('FROM "product_variants" pv')) {
      return variants.map((variant, index) => ({
        id: ids[index], sku: variant.variant_id, name: `Synthetic product ${index + 1}`,
        category: variant.category, costPrice: 10, basePrice: 20, leadTimeDays: 3,
        reviewPeriodDays: 1, minOrderQty: 1, packSize: 1, safetyStockQty: 0, ageDays: variant.days.length,
      }));
    }
    if (sql.includes('HAVING SUM(GREATEST(ib."quantity_on_hand"')) return [];
    if (sql.includes('COALESCE(SUM(GREATEST(ib."quantity_on_hand"')) {
      return variants.map((variant, index) => ({
        variantId: ids[index],
        qty: variant.days.at(-1).stock_end_of_day,
        recentStockout: variant.days.at(-1).stock_end_of_day === 0 &&
          variant.days.slice(-30).some((row) => row.stockout),
      }));
    }
    if (sql.includes('("metric_date")::text AS "day"')) {
      return variants.flatMap((variant) => rowsFor(variant, (row) => ({
        day: row.date,
        units: Math.max(0, row.units_sold - row.units_returned),
        grossUnits: row.units_sold,
      })));
    }
    if (sql.includes('MAX("metric_date")')) {
      return variants.flatMap((variant) => {
        const lastSale = variant.days.filter((row) => row.units_sold > 0).at(-1);
        return lastSale ? [{ variantId: variantIdBySyntheticId.get(variant.variant_id), lastSale: lastSale.date }] : [];
      });
    }
    if (sql.includes('AS "change"') && sql.includes('"quantity_changed"')) {
      return variants.flatMap((variant) => rowsFor(variant, (row) => ({
        day: row.date,
        change: row.received_qty + row.units_returned - row.scrapped_qty - row.units_sold,
        sold: row.units_sold,
      })));
    }
    if (sql.includes('AS "count"') && sql.includes('"quantity_changed"')) {
      return variants.map((variant, index) => ({
        variantId: ids[index],
        total: variant.days.at(-1).stock_end_of_day,
        count: variant.days.length + 1,
        firstDay: variant.days[0].date,
        undated: 0,
      }));
    }
    if (sql.includes('AS "onHand"')) {
      return variants.map((variant, index) => ({ variantId: ids[index], onHand: variant.days.at(-1).stock_end_of_day }));
    }
    if (sql.includes('FROM "supplier_products" sp')) return [];
    if (sql.includes("PERCENTILE_CONT")) return [];
    if (sql.includes('FROM "purchase_order_items" poi')) return [];
    throw new Error(`Unexpected synthetic snapshot query: ${sql.slice(0, 120)}`);
  };
}

const { buildSnapshot } = require("../src/modules/ai-insights/snapshot/build-snapshot");
const { analyze } = require("../src/modules/ai-insights/engine");
const { DEFAULT_SETTINGS } = require("../src/modules/ai-insights/settings");
const { buildInventoryOutlook, inventoryOutlook } = require("../src/modules/ai-insights/inventory-outlook.service");
const { answerPreviousOverstock } = require("../src/modules/assistant/previous-restock.service");

test("synthetic POS data flows through snapshot, inventory rules, current outlook and previous-list filtering", async () => {
  installSyntheticSnapshotQueries();
  const asOf = variants[0].days.at(-1).date;
  const today = new Date(`${asOf}T00:00:00.000Z`);
  today.setUTCDate(today.getUTCDate() + 1);
  const todayText = today.toISOString().slice(0, 10);
  const snapshot = await buildSnapshot("synthetic-business", todayText);
  const analysis = analyze(snapshot, DEFAULT_SETTINGS);
  const displayed = variants.slice(0, 5);
  const displayedIds = displayed.map((variant) => variantIdBySyntheticId.get(variant.variant_id));
  const expectedOverstockIds = displayedIds.filter((variantId) =>
    analysis.findings.some((finding) => finding.variantId === variantId && finding.type === "OVERSTOCK"));

  assert.ok(expectedOverstockIds.includes(variantIdBySyntheticId.get("synthetic-00001")));
  const stockoutSource = variants.find((variant) => variant.scenario === "stockout");
  const stockoutSnapshot = snapshot.variants.find((variant) => variant.sku === stockoutSource.variant_id);
  assert.ok(sum(stockoutSource.days.slice(-30), (row) => row.lost_demand) > 0);
  assert.equal(stockoutSnapshot.possibleStockoutBias, true);
  assert.equal(Object.prototype.hasOwnProperty.call(stockoutSnapshot, "latent_demand"), false);
  assert.equal(stockoutSnapshot.sold60, sum(stockoutSource.days.slice(-60), (row) =>
    Math.max(0, row.units_sold - row.units_returned)));

  const runId = "synthetic-run";
  const dataAsOf = new Date(`${asOf}T00:00:00.000Z`);
  const finishedAt = new Date(`${todayText}T01:00:00.000Z`);
  const latest = {
    id: runId, status: "SUCCEEDED", dataAsOf, startedAt: finishedAt, finishedAt,
    summary: { publicationVersion: 1, forecastStatus: "READY", hasSyntheticSku: true },
    warnings: analysis.warnings,
  };
  const insightRows = analysis.findings.map((finding, index) => {
    const source = variants.find((variant) => variantIdBySyntheticId.get(variant.variant_id) === finding.variantId);
    return {
      id: `synthetic-insight-${index}`, variantId: finding.variantId, runId, type: finding.type,
      severity: finding.severity, status: "OPEN", reasonCode: finding.reasonCode,
      suggestedAction: finding.suggestedAction, metrics: finding.metrics, lastDetectedAt: finishedAt,
      variant: {
        sku: source.variant_id,
        template: { name: `Synthetic product ${variants.indexOf(source) + 1}`, category: { name: source.category } },
      },
      lotItem: null, run: { dataAsOf, finishedAt },
    };
  });
  const items = buildInventoryOutlook(insightRows, [], [], latest, true, true);
  const currentOutlook = items.filter((item) => item.signals.some((signal) => signal.type === "OVERSTOCK" && signal.current));

  prisma.$transaction = async (callback) => callback({
    $queryRaw: async () => [{ today: todayText, now: new Date(finishedAt.getTime() + 60_000) }],
    aiInsightRun: { findFirst: async () => latest },
    aiInsight: { findMany: async () => insightRows },
    aiReplenishmentItem: { findMany: async () => [] },
  });
  const previous = {
    type: "top_sellers_v1", totalSku: variants.length,
    warnings: { excludedSaleItems: 0, excludedReturnItems: 0, missingReturnCostLinks: 0 },
    items: displayed.map((variant, index) => ({
      variantId: displayedIds[index], sku: variant.variant_id, product: `Synthetic product ${index + 1}`,
    })),
  };
  const answer = await answerPreviousOverstock("synthetic-business", previous);

  assert.equal(currentOutlook.length, analysis.findings.filter((finding) =>
    finding.type === "OVERSTOCK" && finding.variantId).length);
  assert.equal(answer.evidence.state, "ready");
  assert.equal(answer.evidence.sourceCount, displayed.length);
  assert.equal(answer.evidence.sourceTruncated, true);
  assert.deepEqual(answer.evidence.items.map((item) => item.variantId), expectedOverstockIds);
  assert.ok(answer.evidence.items.every((item) => displayedIds.includes(item.variantId)));
  assert.equal(answer.evidence.totalSku, expectedOverstockIds.length);
});
