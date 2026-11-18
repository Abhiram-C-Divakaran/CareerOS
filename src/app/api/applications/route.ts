import { NextRequest, NextResponse } from "next/server";
import {
  createOrDeduplicateApplication,
  listApplications,
  updateApplicationStatusAndFields,
} from "@/lib/db";
import { ApplicationPortal, ApplicationStatus, EventSource, PriorityLevel } from "@/lib/types";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || undefined;
  const portal = searchParams.get("portal") || undefined;
  const search = searchParams.get("search") || undefined;

  const applications = listApplications({ status, portal, search });
  return NextResponse.json({ applications });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      company?: string;
      role?: string;
      portal?: ApplicationPortal;
      portalApplicationId?: string | null;
      sourceUrl?: string | null;
      location?: string | null;
      workMode?: "Remote" | "Hybrid" | "On-site" | null;
      compensation?: string | null;
      status?: ApplicationStatus;
      appliedDate?: string;
      assessmentDeadline?: string | null;
      followUpDate?: string | null;
      recruiterEmail?: string | null;
      notes?: string | null;
      priority?: PriorityLevel;
      source?: EventSource;
    };

    if (!body.company || !body.role) {
      return NextResponse.json(
        { error: "Company and role are required fields." },
        { status: 400 }
      );
    }

    const result = createOrDeduplicateApplication({
      company: body.company,
      role: body.role,
      portal: body.portal || "Company Website",
      portalApplicationId: body.portalApplicationId,
      sourceUrl: body.sourceUrl,
      location: body.location,
      workMode: body.workMode,
      compensation: body.compensation,
      status: body.status || "APPLIED",
      appliedDate: body.appliedDate,
      assessmentDeadline: body.assessmentDeadline,
      followUpDate: body.followUpDate,
      recruiterEmail: body.recruiterEmail,
      notes: body.notes,
      priority: body.priority || "MEDIUM",
      source: body.source || "MANUAL",
    });

    return NextResponse.json(result, { status: result.deduplicated ? 200 : 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save application" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      id?: string;
      status?: ApplicationStatus;
      portalApplicationId?: string | null;
      sourceUrl?: string | null;
      location?: string | null;
      workMode?: "Remote" | "Hybrid" | "On-site" | null;
      compensation?: string | null;
      assessmentDeadline?: string | null;
      followUpDate?: string | null;
      nextInterviewAt?: string | null;
      recruiterEmail?: string | null;
      notes?: string | null;
      priority?: PriorityLevel;
      source?: EventSource;
      reasonNote?: string;
    };

    if (!body.id) {
      return NextResponse.json(
        { error: "Application ID is required" },
        { status: 400 }
      );
    }

    const updated = updateApplicationStatusAndFields(body.id, {
      status: body.status,
      portalApplicationId: body.portalApplicationId,
      sourceUrl: body.sourceUrl,
      location: body.location,
      workMode: body.workMode,
      compensation: body.compensation,
      assessmentDeadline: body.assessmentDeadline,
      followUpDate: body.followUpDate,
      nextInterviewAt: body.nextInterviewAt,
      recruiterEmail: body.recruiterEmail,
      notes: body.notes,
      priority: body.priority,
      source: body.source || "MANUAL",
      reasonNote: body.reasonNote,
    });

    if (!updated) {
      return NextResponse.json(
        { error: "Application not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ application: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update application" },
      { status: 500 }
    );
  }
}
