/// <reference types="node" />
import "dotenv/config";
import process from "node:process";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DIRECT_URL") || env("DATABASE_URL") || process.env.DIRECT_URL || process.env.DATABASE_URL || "",
  },
});
