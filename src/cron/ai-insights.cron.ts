import { runScheduledInsights } from "../modules/ai-insights/ai-insights.service";

/** Nightly job (02:00 Asia/Ho_Chi_Minh, see server.ts). Catches its own errors so a failure never crashes the server. */
export async function aiInsightsCron() {
  try {
    return await runScheduledInsights();
  } catch (error) {
    console.error("AI insight job failed.", error);
    return { succeeded: 0, failed: 0 };
  }
}
