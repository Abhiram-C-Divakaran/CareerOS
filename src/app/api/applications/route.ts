import { NextRequest, NextResponse } from "next/server";
import {
  createOrDeduplicateApplication,
  listApplications,
  updateApplicationStatusAndFields,
} from "@/lib/db";
import { requireAuthenticatedSession } from "@/lib/security";
import {
  validateApplicationPortal,
  validateApplicationStatus,
  validateOptionalIsoDate,
  validateOptionalString,
  validatePriority,
  validateRequiredString,
  validateSafeHttpUrl,
  validateWorkMode,
  ValidationError,
} from "@/lib/validation";

export async function GET(req: NextRequest) {
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || undefined;
  const portal = searchParams.get("portal") || undefined;
  const search = searchParams.get("search") || undefined;

  if (status && status !== "ALL") {
    try {
      validateApplicationStatus(status);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid status filter" },
        { status: 400 }
      );
    }
  }

  if (portal && portal !== "ALL") {
    try {
      validateApplicationPortal(portal);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid portal filter" },
        { status: 400 }
      );
    }
  }

  const applications = listApplications({ status, portal, search });
  return NextResponse.json({ applications });
}

export async function POST(req: NextRequest) {
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  try {
    const body = (await req.json()) as Record<string, unknown>;

    const company = validateRequiredString(body.company, "company", 140);
    const role = validateRequiredString(body.role, "role", 160);
    const portal = body.portal
      ? validateApplicationPortal(body.portal)
      : "Company Website";
    const status = body.status
      ? validateApplicationStatus(body.status)
      : "APPLIED";
    const priority = body.priority
      ? validatePriority(body.priority)
      : "MEDIUM";
    const workMode = validateWorkMode(body.workMode);
    const portalApplicationId = validateOptionalString(
      body.portalApplicationId,
      "portalApplicationId",
      80
    );
    const sourceUrl = validateSafeHttpUrl(body.sourceUrl, "sourceUrl");
    const location = validateOptionalString(body.location, "location", 120);
    const compensation = validateOptionalString(
      body.compensation,
      "compensation",
      80
    );
    const appliedDate =
      validateOptionalIsoDate(body.appliedDate, "appliedDate") || undefined;
    const assessmentDeadline = validateOptionalIsoDate(
      body.assessmentDeadline,
      "assessmentDeadline"
    );
    const followUpDate = validateOptionalIsoDate(
      body.followUpDate,
      "followUpDate"
    );
    const recruiterEmail = validateOptionalString(
      body.recruiterEmail,
      "recruiterEmail",
      160
    );
    const notes = validateOptionalString(body.notes, "notes", 2000);

    const result = createOrDeduplicateApplication({
      company,
      role,
      portal,
      portalApplicationId,
      sourceUrl,
      location,
      workMode,
      compensation,
      status,
      appliedDate,
      assessmentDeadline,
      followUpDate,
      recruiterEmail,
      notes,
      priority,
      source: "MANUAL",
    });

    return NextResponse.json(result, {
      status: result.deduplicated ? 200 : 201,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to save application",
      },
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
        ? validateApplicationStatus(body.status)
        : undefined;
    const priority =
      body.priority !== undefined ? validatePriority(body.priority) : undefined;
    const workMode =
      body.workMode !== undefined ? validateWorkMode(body.workMode) : undefined;
    const portalApplicationId =
      body.portalApplicationId !== undefined
        ? validateOptionalString(
            body.portalApplicationId,
            "portalApplicationId",
            80
          )
        : undefined;
    const sourceUrl =
      body.sourceUrl !== undefined
        ? validateSafeHttpUrl(body.sourceUrl, "sourceUrl")
        : undefined;
    const location =
      body.location !== undefined
        ? validateOptionalString(body.location, "location", 120)
        : undefined;
    const compensation =
      body.compensation !== undefined
        ? validateOptionalString(body.compensation, "compensation", 80)
        : undefined;
    const assessmentDeadline =
      body.assessmentDeadline !== undefined
        ? validateOptionalIsoDate(body.assessmentDeadline, "assessmentDeadline")
        : undefined;
    const followUpDate =
      body.followUpDate !== undefined
        ? validateOptionalIsoDate(body.followUpDate, "followUpDate")
        : undefined;
    const nextInterviewAt =
      body.nextInterviewAt !== undefined
        ? validateOptionalIsoDate(body.nextInterviewAt, "nextInterviewAt")
        : undefined;
    const recruiterEmail =
      body.recruiterEmail !== undefined
        ? validateOptionalString(body.recruiterEmail, "recruiterEmail", 160)
        : undefined;
    const notes =
      body.notes !== undefined
        ? validateOptionalString(body.notes, "notes", 2000)
        : undefined;
    const reasonNote =
      body.reasonNote !== undefined
        ? validateOptionalString(body.reasonNote, "reasonNote", 500) ||
          undefined
        : undefined;

    const updated = updateApplicationStatusAndFields(id, {
      status,
      portalApplicationId,
      sourceUrl,
      location,
      workMode,
      compensation,
      assessmentDeadline,
      followUpDate,
      nextInterviewAt,
      recruiterEmail,
      notes,
      priority,
      source: "MANUAL",
      reasonNote,
    });

    if (!updated) {
      return NextResponse.json(
        { error: "Application not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ application: updated });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to update application",
      },
      { status: 500 }
    );
  }
}
