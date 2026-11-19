import { NextRequest, NextResponse } from "next/server";
import { getDb, listTimelineEvents } from "@/lib/db";
import { requireAuthenticatedSession } from "@/lib/security";
import {
  escapeSafeCsvCell,
  validateApplicationStatus,
  validateEventSource,
  validateOptionalIsoDate,
  ValidationError,
} from "@/lib/validation";

export async function GET(req: NextRequest) {
  getDb();
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  const { searchParams } = new URL(req.url);
  const applicationId = searchParams.get("applicationId") || undefined;
  const sourceParam = searchParams.get("source") || undefined;
  const statusParam = searchParams.get("status") || undefined;
  const search = searchParams.get("search") || undefined;
  const fromDateParam = searchParams.get("fromDate") || undefined;
  const toDateParam = searchParams.get("toDate") || undefined;
  const exportFormat = searchParams.get("export");

  let status: string | undefined;
  let source: string | undefined;
  let fromDate: string | undefined;
  let toDate: string | undefined;

  try {
    if (statusParam && statusParam !== "ALL") {
      status = validateApplicationStatus(statusParam);
    }
    if (sourceParam && sourceParam !== "ALL") {
      source = validateEventSource(sourceParam);
    }
    if (fromDateParam) {
      fromDate = validateOptionalIsoDate(fromDateParam, "fromDate") || undefined;
    }
    if (toDateParam) {
      toDate = validateOptionalIsoDate(toDateParam, "toDate") || undefined;
    }
    if (exportFormat && exportFormat !== "csv" && exportFormat !== "json") {
      throw new ValidationError("export must be 'csv' or 'json'.");
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid query parameters" },
      { status: 400 }
    );
  }

  const events = listTimelineEvents({
    applicationId,
    source,
    status,
    search,
    fromDate,
    toDate,
  });

  if (exportFormat === "csv") {
    const headers = [
      "Event ID",
      "Timestamp",
      "Company",
      "Role",
      "Event Type",
      "Previous Status",
      "New Status",
      "Source",
      "External Reference ID",
      "Title",
      "Description",
    ];
    const rows = events.map((ev) =>
      [
        ev.id,
        ev.eventTimestamp,
        ev.company,
        ev.role,
        ev.eventType,
        ev.previousStatus || "",
        ev.newStatus || "",
        ev.source,
        ev.externalReferenceId || "",
        ev.title,
        ev.description,
      ]
        .map(escapeSafeCsvCell)
        .join(",")
    );

    const csvContent = [headers.join(","), ...rows].join("\n");
    return new NextResponse(csvContent, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="careeros-immutable-history-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      },
    });
  }

  if (exportFormat === "json") {
    return new NextResponse(
      JSON.stringify({ immutableTimeline: events }, null, 2),
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="careeros-immutable-history-${new Date()
            .toISOString()
            .slice(0, 10)}.json"`,
        },
      }
    );
  }

  return NextResponse.json({
    events,
    totalCount: events.length,
    immutableEnforced: true,
  });
}
