import { NextResponse } from "next/server";
import { generateDailyBriefing, getLatestDailyBriefing } from "@/lib/db";

export async function GET() {
  const briefing = getLatestDailyBriefing();
  return NextResponse.json({ briefing });
}

export async function POST() {
  const briefing = generateDailyBriefing();
  return NextResponse.json({ briefing, regenerated: true });
}
