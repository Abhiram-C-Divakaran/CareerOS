import { NextRequest, NextResponse } from "next/server";
import {
  getDb,
  getLatestDailyBriefing,
  getOAuthIntegrationStatus,
  listApplications,
  listInterviews,
  listSyncedEmails,
  listTimelineEvents,
} from "@/lib/db";
import { requireAuthenticatedSession } from "@/lib/security";

export async function GET(req: NextRequest) {
  getDb();
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  const applications = listApplications();
  const interviews = listInterviews(true);
  const timeline = listTimelineEvents();
  const syncedEmails = listSyncedEmails();
  const briefing = getLatestDailyBriefing();
  const oauthStatus = getOAuthIntegrationStatus();

  const now = new Date();
  const todayDateStr = now.toISOString().slice(0, 10);

  const activeApplications = applications.filter(
    (a) => !["REJECTED", "WITHDRAWN"].includes(a.status)
  );
  const offers = applications.filter((a) => a.status === "OFFER");
  const rejections = applications.filter((a) => a.status === "REJECTED");
  const upcomingInterviews = interviews.filter(
    (i) =>
      i.status === "UPCOMING" &&
      new Date(i.scheduledStart).getTime() >= now.getTime() - 2 * 3600 * 1000
  );
  const todaysInterviews = upcomingInterviews.filter(
    (i) => i.scheduledStart.slice(0, 10) === todayDateStr
  );

  const pendingAssessments = activeApplications.filter(
    (a) => a.status === "ASSESSMENT" || Boolean(a.assessmentDeadline)
  );
  const pendingFollowUps = activeApplications.filter(
    (a) =>
      (a.status === "APPLIED" || a.status === "UNDER_REVIEW") &&
      a.followUpDate &&
      new Date(a.followUpDate).getTime() <= now.getTime() + 48 * 3600 * 1000
  );

  const portalCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  for (const app of applications) {
    portalCounts[app.portal] = (portalCounts[app.portal] || 0) + 1;
    statusCounts[app.status] = (statusCounts[app.status] || 0) + 1;
  }

  return NextResponse.json({
    applications,
    interviews,
    timeline,
    syncedEmails,
    briefing,
    oauthStatus,
    stats: {
      totalApplications: applications.length,
      activeApplications: activeApplications.length,
      offersCount: offers.length,
      rejectionsCount: rejections.length,
      upcomingInterviewsCount: upcomingInterviews.length,
      todaysEventsCount: todaysInterviews.length + pendingAssessments.length,
      pendingAssessmentsCount: pendingAssessments.length,
      pendingFollowUpsCount: pendingFollowUps.length,
      portalCounts,
      statusCounts,
    },
  });
}
