/**
 * CareerOS Scheduled Daily Assistant & Sync Job
 * Run via: npm run sync:cron
 */
import { generateDailyBriefing, getOAuthIntegrationStatus } from "../src/lib/db.ts";
import {
  syncLiveGmailMessages,
  syncLiveGoogleCalendar,
} from "../src/lib/google-integration.ts";

async function runDailyScheduledJob() {
  console.log(`[CareerOS Cron] Starting daily job at ${new Date().toISOString()}...`);

  const oauth = getOAuthIntegrationStatus();
  if (oauth.connected && oauth.tokenStatus !== "REVOKED") {
    try {
      const gmailRes = await syncLiveGmailMessages();
      console.log(
        `[CareerOS Cron] Gmail sync completed: ${gmailRes.processedCount} messages processed (${gmailRes.newApplications} new, ${gmailRes.deduplicatedCount} deduplicated, ${gmailRes.skippedNonJobCount} non-job skipped).`
      );
    } catch (err) {
      console.warn(`[CareerOS Cron] Gmail sync failed:`, (err as Error).message);
    }

    try {
      const calRes = await syncLiveGoogleCalendar();
      console.log(
        `[CareerOS Cron] Calendar sync completed: ${calRes.interviewsSynced} interview(s) synced.`
      );
    } catch (err) {
      console.warn(`[CareerOS Cron] Calendar sync failed:`, (err as Error).message);
    }
  } else if (oauth.tokenStatus === "REVOKED") {
    console.warn(
      `[CareerOS Cron] Google OAuth token is REVOKED (${oauth.lastSyncError || "reconnect required"}). Skipping remote sync.`
    );
  } else {
    console.log(
      `[CareerOS Cron] Google OAuth not connected yet; generating Daily AI Briefing from local SQLite records.`
    );
  }

  const briefing = generateDailyBriefing();
  console.log(`[CareerOS Cron] Daily AI Briefing generated (${briefing.id}):`);
  console.log(`  Headline: ${briefing.headline}`);
  console.log(`  Summary:  ${briefing.executiveSummary}`);
}

runDailyScheduledJob().catch((err) => {
  console.error("[CareerOS Cron] Fatal error:", err);
  process.exit(1);
});
