import { NextRequest, NextResponse } from "next/server";
import { createOrUpdateInterview, getDb, listInterviews } from "@/lib/db";
import { requireAuthenticatedSession } from "@/lib/security";
import {
  validateInterviewStatus,
  validateOptionalIsoDate,
  validateOptionalString,
  validateRequiredString,
  validateSafeHttpUrl,
  ValidationError,
} from "@/lib/validation";

export async function GET(req: NextRequest) {
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  const interviews = listInterviews(true);
  return NextResponse.json({ interviews });
}

export async function POST(req: NextRequest) {
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  try {
    const body = (await req.json()) as Record<string, unknown>;

    const company = validateRequiredString(body.company, "company", 140);
    const role = validateRequiredString(body.role, "role", 160);
    const roundName = validateRequiredString(body.roundName, "roundName", 160);
    const scheduledStart = validateOptionalIsoDate(
      body.scheduledStart,
      "scheduledStart"
    );
    if (!scheduledStart) {
      return NextResponse.json(
        { error: "scheduledStart is required and must be a valid ISO date." },
        { status: 400 }
      );
    }

    const scheduledEnd =
      validateOptionalIsoDate(body.scheduledEnd, "scheduledEnd") || undefined;
    const meetingLink = validateSafeHttpUrl(body.meetingLink, "meetingLink");
    const organizerEmail = validateOptionalString(
      body.organizerEmail,
      "organizerEmail",
      160
    );
    const calendarEventId = validateOptionalString(
      body.calendarEventId,
      "calendarEventId",
      160
    );
    const prepNotes = validateOptionalString(body.prepNotes, "prepNotes", 2000);
    const applicationId = validateOptionalString(
      body.applicationId,
      "applicationId",
      80
    );
    const reminderMinutesBefore =
      typeof body.reminderMinutesBefore === "number" &&
      body.reminderMinutesBefore >= 0 &&
      body.reminderMinutesBefore <= 10080
        ? Math.floor(body.reminderMinutesBefore)
        : 30;

    const res = createOrUpdateInterview({
      applicationId,
      company,
      role,
      roundName,
      scheduledStart,
      scheduledEnd,
      meetingLink,
      organizerEmail,
      calendarEventId,
      prepNotes,
      reminderMinutesBefore,
      source: "MANUAL",
    });

    return NextResponse.json(res, { status: res.created ? 201 : 200 });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save interview" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const id = validateRequiredString(body.id, "id", 80);

    const status =
      body.status !== undefined
        ? validateInterviewStatus(body.status)
        : undefined;
    const prepNotes =
      body.prepNotes !== undefined
        ? validateOptionalString(body.prepNotes, "prepNotes", 2000)
        : undefined;
    const meetingLink =
      body.meetingLink !== undefined
        ? validateSafeHttpUrl(body.meetingLink, "meetingLink")
        : undefined;

    const db = getDb();
    const existing = db
      .prepare(`SELECT * FROM interviews WHERE id = ?`)
      .get(id);
    if (!existing) {
      return NextResponse.json(
        { error: "Interview not found" },
        { status: 404 }
      );
    }

    db.prepare(
      `UPDATE interviews SET
        status = ?,
        reminder_dismissed = ?,
        prep_notes = ?,
        meeting_link = ?
      WHERE id = ?`
    ).run(
      status ?? existing.status,
      body.reminderDismissed !== undefined
        ? body.reminderDismissed
          ? 1
          : 0
        : existing.reminder_dismissed,
      prepNotes !== undefined ? prepNotes : existing.prep_notes,
      meetingLink !== undefined ? meetingLink : existing.meeting_link,
      id
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to update interview",
      },
      { status: 500 }
    );
  }
}
