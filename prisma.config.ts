import "dotenv/config";
import process from "node:process";
import { defineConfig } from "prisma/config";

// Allow time for the remote database/pooler to establish a CLI connection.
// Keep an explicitly configured timeout unchanged.
const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";
const migrationUrl = databaseUrl ? new URL(databaseUrl) : undefined;
if (migrationUrl && !migrationUrl.searchParams.has("connect_timeout")) {
  migrationUrl.searchParams.set("connect_timeout", "30");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: migrationUrl?.toString() ?? "",
  },
});
