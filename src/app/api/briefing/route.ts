import { NextRequest, NextResponse } from "next/server";
import { generateDailyBriefing, getLatestDailyBriefing } from "@/lib/db";
import { requireAuthenticatedSession } from "@/lib/security";

export async function GET(req: NextRequest) {
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  const briefing = getLatestDailyBriefing();
  return NextResponse.json({ briefing });
}

export async function POST(req: NextRequest) {
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  const briefing = generateDailyBriefing();
  return NextResponse.json({ briefing, regenerated: true });
}
