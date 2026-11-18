import { NextRequest, NextResponse } from "next/server";
import { createOrUpdateInterview, getDb, listInterviews } from "@/lib/db";
import { EventSource } from "@/lib/types";

export async function GET() {
  const interviews = listInterviews(true);
  return NextResponse.json({ interviews });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      applicationId?: string | null;
      company?: string;
      role?: string;
      roundName?: string;
      scheduledStart?: string;
      scheduledEnd?: string;
      meetingLink?: string | null;
      organizerEmail?: string | null;
      calendarEventId?: string | null;
      prepNotes?: string | null;
      reminderMinutesBefore?: number;
      source?: EventSource;
    };

    if (!body.company || !body.role || !body.roundName || !body.scheduledStart) {
      return NextResponse.json(
        { error: "Company, role, roundName, and scheduledStart are required." },
        { status: 400 }
      );
    }

    const res = createOrUpdateInterview({
      applicationId: body.applicationId,
      company: body.company,
      role: body.role,
      roundName: body.roundName,
      scheduledStart: body.scheduledStart,
      scheduledEnd: body.scheduledEnd,
      meetingLink: body.meetingLink,
      organizerEmail: body.organizerEmail,
      calendarEventId: body.calendarEventId,
      prepNotes: body.prepNotes,
      reminderMinutesBefore: body.reminderMinutesBefore ?? 30,
      source: body.source || "MANUAL",
    });

    return NextResponse.json(res, { status: res.created ? 201 : 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save interview" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      id?: string;
      status?: "UPCOMING" | "COMPLETED" | "CANCELLED";
      reminderDismissed?: boolean;
      prepNotes?: string;
      meetingLink?: string;
    };

    if (!body.id) {
      return NextResponse.json({ error: "Interview ID required" }, { status: 400 });
    }

    const db = getDb();
    const existing = db
      .prepare(`SELECT * FROM interviews WHERE id = ?`)
      .get(body.id);
    if (!existing) {
      return NextResponse.json({ error: "Interview not found" }, { status: 404 });
    }

    db.prepare(
      `UPDATE interviews SET
        status = ?,
        reminder_dismissed = ?,
        prep_notes = ?,
        meeting_link = ?
      WHERE id = ?`
    ).run(
      body.status ?? existing.status,
      body.reminderDismissed !== undefined
        ? body.reminderDismissed
          ? 1
          : 0
        : existing.reminder_dismissed,
      body.prepNotes !== undefined ? body.prepNotes : existing.prep_notes,
      body.meetingLink !== undefined ? body.meetingLink : existing.meeting_link,
      body.id
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update interview" },
      { status: 500 }
    );
  }
}
