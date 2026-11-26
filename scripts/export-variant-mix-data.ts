import "dotenv/config";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

type ExportArgs = {
  businessId: string;
  from: string;
  to: string;
  out: string;
};

type PriorLedgerRow = {
  business_id: string;
  variant_id: string;
  lot_item_id: string | null;
  transaction_type: string;
  quantity_changed: number;
  balance_after: number;
  created_at: Date | null;
};

type CompletedPosSaleRow = {
  business_id: string;
  variant_id: string;
  metric_date: Date | string;
  source_group: "DEMO_AI" | "DEMO_F05" | "DEMO_OTHER" | "UNCLASSIFIED";
  units_sold: number;
  order_count: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function printHelp() {
  console.log(
    "Read-only ABC POS export\n\n" +
    "Usage: npm run export:variant-mix -- --business-id UUID --from YYYY-MM-DD --to YYYY-MM-DD --out DIRECTORY\n\n" +
    "Writes SKU attributes, stored POS daily metrics, and inventory-ledger events. " +
    "It does not infer zero-sales days or all-day availability.",
  );
}

function parseArgs(values: string[]): ExportArgs | null {
  if (values.includes("--help") || values.includes("-h")) {
    printHelp();
    return null;
  }
  const parsed = new Map<string, string>();
  const allowed = new Set(["--business-id", "--from", "--to", "--out"]);
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (!allowed.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (parsed.has(option)) throw new Error(`${option} may only be specified once`);
    parsed.set(option, value);
    index += 1;
  }

  const businessId = parsed.get("--business-id");
  const from = parsed.get("--from");
  const to = parsed.get("--to");
  const out = parsed.get("--out");
  if (!businessId || !from || !to || !out) {
    throw new Error("Required options: --business-id, --from, --to, --out");
  }
  if (!UUID_PATTERN.test(businessId)) throw new Error("--business-id must be a UUID");
  validateDate(from, "--from");
  validateDate(to, "--to");
  if (from > to) throw new Error("--from must be on or before --to");
  return { businessId, from, to, out };
}

function validateDate(value: string, option: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${option} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${option} must be a valid calendar date`);
  }
}

function buildConnectionString(raw: string) {
  try {
    const url = new URL(raw);
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return raw;
  }
}

function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(headers: string[], rows: Array<Record<string, string | number | boolean | null>>) {
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
    "",
  ].join("\r\n");
}

function dateOnly(value: Date | string) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function nextDay(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function businessDayStart(value: string) {
  return new Date(`${value}T00:00:00.000+07:00`);
}

function writeExport(outDir: string, files: Map<string, string>) {
  if (existsSync(outDir)) {
    throw new Error(`Refusing to overwrite existing export directory: ${outDir}`);
  }
  mkdirSync(dirname(outDir), { recursive: true });
  mkdirSync(outDir);
  for (const [name, contents] of files) {
    writeFileSync(join(outDir, name), contents, { encoding: "utf8", flag: "wx" });
  }
}

async function exportData(args: ExportArgs) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: buildConnectionString(databaseUrl),
      ssl: { rejectUnauthorized: false },
      max: 3,
    }),
  });

  try {
    const variants = await prisma.productVariant.findMany({
      where: {
        businessId: args.businessId,
        OR: [{ isActive: true }, { isActive: null }],
      },
      select: {
        id: true,
        businessId: true,
        templateId: true,
        isActive: true,
        template: {
          select: {
            category: { select: { name: true } },
          },
        },
        variantAttributeValues: {
          select: {
            attribute: { select: { name: true } },
            attributeValue: { select: { value: true } },
          },
        },
      },
      orderBy: [{ templateId: "asc" }, { id: "asc" }],
    });
    const variantIds = variants.map((variant) => variant.id);
    const metricFrom = new Date(`${args.from}T00:00:00.000Z`);
    const metricTo = new Date(`${args.to}T00:00:00.000Z`);
    const ledgerFrom = businessDayStart(args.from);
    const ledgerTo = businessDayStart(nextDay(args.to));

    const [metrics, ledgerMovements, priorLedger, completedPosSales] = variantIds.length
      ? await Promise.all([
          prisma.channelDailyProductMetric.findMany({
            where: {
              businessId: args.businessId,
              channel: "POS",
              variantId: { in: variantIds },
              metricDate: { gte: metricFrom, lte: metricTo },
            },
            select: {
              businessId: true,
              variantId: true,
              channel: true,
              metricDate: true,
              unitsSold: true,
              unitsReturned: true,
            },
            orderBy: [{ metricDate: "asc" }, { variantId: "asc" }],
          }),
          prisma.inventoryLedger.findMany({
            where: {
              businessId: args.businessId,
              variantId: { in: variantIds },
              createdAt: { gte: ledgerFrom, lt: ledgerTo },
            },
            select: {
              businessId: true,
              variantId: true,
              lotItemId: true,
              transactionType: true,
              quantityChanged: true,
              balanceAfter: true,
              createdAt: true,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          }),
          prisma.$queryRaw<PriorLedgerRow[]>`
            SELECT DISTINCT ON ("variant_id", "lot_item_id")
              "business_id",
              "variant_id",
              "lot_item_id",
              "transaction_type",
              "quantity_changed",
              "balance_after",
              "created_at"
            FROM "inventory_ledger"
            WHERE "business_id" = ${args.businessId}::uuid
              AND "variant_id" = ANY(${variantIds}::uuid[])
              AND "created_at" < ${ledgerFrom}
              AND "created_at" IS NOT NULL
            ORDER BY "variant_id", "lot_item_id", "created_at" DESC, "id" DESC
          `,
          prisma.$queryRaw<CompletedPosSaleRow[]>`
            SELECT
              o."business_id",
              oi."variant_id",
              (o."created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS "metric_date",
              CASE
                WHEN o."order_code" LIKE 'DEMO-AI-%' THEN 'DEMO_AI'
                WHEN o."order_code" LIKE 'ORD-F05-DEMO-%' THEN 'DEMO_F05'
                WHEN o."order_code" LIKE 'DEMO-%' THEN 'DEMO_OTHER'
                ELSE 'UNCLASSIFIED'
              END AS "source_group",
              SUM(oi."quantity")::int AS "units_sold",
              COUNT(DISTINCT o."id")::int AS "order_count"
            FROM "orders" o
            JOIN "order_items" oi ON oi."order_id" = o."id"
            JOIN "product_variants" v
              ON v."id" = oi."variant_id" AND v."business_id" = o."business_id"
            WHERE o."business_id" = ${args.businessId}::uuid
              AND o."status" = 'COMPLETED'
              AND o."created_at" >= ${ledgerFrom}
              AND o."created_at" < ${ledgerTo}
              AND oi."variant_id" = ANY(${variantIds}::uuid[])
            GROUP BY o."business_id", "metric_date", oi."variant_id", "source_group"
            ORDER BY "metric_date" ASC, oi."variant_id" ASC, "source_group" ASC
          `,
        ])
      : [[], [], [], []];

    const variantRows = variants.map((variant) => ({
      business_id: variant.businessId,
      product_id: variant.templateId,
      variant_id: variant.id,
      category: variant.template.category?.name ?? "",
      is_active: variant.isActive !== false,
    }));
    const attributeRows = variants.flatMap((variant) =>
      variant.variantAttributeValues.map((value) => ({
        business_id: variant.businessId,
        variant_id: variant.id,
        attribute_name: value.attribute.name,
        attribute_value: value.attributeValue.value,
      })),
    );
    const metricRows = metrics.map((metric) => ({
      business_id: metric.businessId,
      variant_id: metric.variantId,
      channel: metric.channel,
      metric_date: dateOnly(metric.metricDate),
      units_sold: metric.unitsSold,
      units_returned: metric.unitsReturned,
    }));
    const completedPosSalesBySourceRows = completedPosSales.map((sale) => ({
      business_id: sale.business_id,
      variant_id: sale.variant_id,
      metric_date: dateOnly(sale.metric_date),
      source_group: sale.source_group,
      units_sold: sale.units_sold,
      order_count: sale.order_count,
    }));
    const unclassifiedPosSalesRows = completedPosSalesBySourceRows.filter(
      (sale) => sale.source_group === "UNCLASSIFIED",
    );
    const completedSalesByDayAndVariant = new Map<string, {
      business_id: string;
      variant_id: string;
      metric_date: string;
      units_sold: number;
      order_count: number;
    }>();
    for (const sale of completedPosSalesBySourceRows) {
      const key = `${sale.business_id}:${sale.variant_id}:${sale.metric_date}`;
      const aggregate = completedSalesByDayAndVariant.get(key);
      if (aggregate) {
        aggregate.units_sold += sale.units_sold;
        aggregate.order_count += sale.order_count;
      } else {
        completedSalesByDayAndVariant.set(key, {
          business_id: sale.business_id,
          variant_id: sale.variant_id,
          metric_date: sale.metric_date,
          units_sold: sale.units_sold,
          order_count: sale.order_count,
        });
      }
    }
    const completedPosSaleRows = [...completedSalesByDayAndVariant.values()];
    const ledgerRows = [
      ...priorLedger.map((row) => ({
        record_role: "prior_state",
        business_id: row.business_id,
        variant_id: row.variant_id,
        lot_item_id: row.lot_item_id,
        transaction_type: row.transaction_type,
        quantity_changed: row.quantity_changed,
        balance_after: row.balance_after,
        created_at: row.created_at?.toISOString() ?? "",
      })),
      ...ledgerMovements.map((row) => ({
        record_role: "movement",
        business_id: row.businessId,
        variant_id: row.variantId,
        lot_item_id: row.lotItemId,
        transaction_type: row.transactionType,
        quantity_changed: row.quantityChanged,
        balance_after: row.balanceAfter,
        created_at: row.createdAt?.toISOString() ?? "",
      })),
    ];

    const outDir = resolve(args.out);
    const files = new Map([
      ["variants.csv", csv(
        ["business_id", "product_id", "variant_id", "category", "is_active"],
        variantRows,
      )],
      ["variant_attributes.csv", csv(
        ["business_id", "variant_id", "attribute_name", "attribute_value"],
        attributeRows,
      )],
      ["daily_metrics.csv", csv(
        ["business_id", "variant_id", "channel", "metric_date", "units_sold", "units_returned"],
        metricRows,
      )],
      ["completed_pos_sales.csv", csv(
        ["business_id", "variant_id", "metric_date", "units_sold", "order_count"],
        completedPosSaleRows,
      )],
      ["completed_pos_sales_by_source.csv", csv(
        [
          "business_id", "variant_id", "metric_date", "source_group",
          "units_sold", "order_count",
        ],
        completedPosSalesBySourceRows,
      )],
      ["completed_pos_sales_unclassified.csv", csv(
        [
          "business_id", "variant_id", "metric_date", "source_group",
          "units_sold", "order_count",
        ],
        unclassifiedPosSalesRows,
      )],
      ["inventory_ledger.csv", csv(
        [
          "record_role", "business_id", "variant_id", "lot_item_id",
          "transaction_type", "quantity_changed", "balance_after", "created_at",
        ],
        ledgerRows,
      )],
    ]);
    writeExport(outDir, files);
    console.log(
      `Exported ${variants.length} active SKU rows, ${attributeRows.length} attributes, ` +
      `${metrics.length} stored POS metric rows, ${completedPosSaleRows.length} completed POS sales aggregates, ` +
      `${completedPosSalesBySourceRows.length} source-classified aggregates, and ${ledgerRows.length} ledger rows.`,
    );
    console.log("No zero-sales days or all-day availability were inferred.");
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;
  await exportData(args);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
