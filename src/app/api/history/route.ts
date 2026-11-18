import { NextRequest, NextResponse } from "next/server";
import { listTimelineEvents } from "@/lib/db";
import { requireAuthenticatedSession } from "@/lib/security";
import { validateApplicationStatus } from "@/lib/validation";

export async function GET(req: NextRequest) {
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  const { searchParams } = new URL(req.url);
  const applicationId = searchParams.get("applicationId") || undefined;
  const source = searchParams.get("source") || undefined;
  const status = searchParams.get("status") || undefined;
  const search = searchParams.get("search") || undefined;
  const fromDate = searchParams.get("fromDate") || undefined;
  const toDate = searchParams.get("toDate") || undefined;
  const exportFormat = searchParams.get("export");

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
    const escapeCsv = (val: string | null | undefined) => {
      if (val === null || val === undefined) return '""';
      return `"${String(val).replace(/"/g, '""')}"`;
    };
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
        .map(escapeCsv)
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
