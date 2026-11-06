import app from "./app";
import cron from "node-cron";
import dotenv from "dotenv";
import { prisma } from "./shared/infrastructure/database/prisma.client";
import { updateLotStatusesCron } from "./cron/update-lot-statuses.cron";

dotenv.config();

const PORT = process.env.PORT || 5000;

async function checkDatabaseConnection() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not configured. Skipping database connection check.");
    return;
  }

  try {
    await prisma.$connect();
    console.log("Database connected successfully.");
  } catch (error) {
    console.error("Database connection failed.");
    console.error(error);
  }
}

function startLotStatusJob() {
  if (!process.env.DATABASE_URL) {
    return;
  }

  // 06:00 every day, Vietnam time. updateLotStatusesCron catches its own errors.
  cron.schedule("0 6 * * *", () => void updateLotStatusesCron(), { timezone: "Asia/Ho_Chi_Minh" });

  // Dev only: every 10 seconds for testing
  // cron.schedule("*/10 * * * * *", () => void updateLotStatusesCron(), { timezone: "Asia/Ho_Chi_Minh" });

  // The job is idempotent. Running it at startup covers a missed 06:00 run while the server was down.
  void updateLotStatusesCron();
}

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await checkDatabaseConnection();
  startLotStatusJob();
});
