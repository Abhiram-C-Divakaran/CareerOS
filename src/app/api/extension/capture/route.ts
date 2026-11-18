import { NextRequest, NextResponse } from "next/server";
import { createOrDeduplicateApplication } from "@/lib/db";
import { detectPortalFromText, extractApplicationId } from "@/lib/email-parser";
import { ApplicationPortal, ApplicationStatus } from "@/lib/types";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CareerOS-Source",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
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
      status?: ApplicationStatus;
      pageTextSnippet?: string;
      notes?: string;
    };

    const detected = detectPortalFromText(
      "",
      `${body.company || ""} ${body.role || ""}`,
      body.pageTextSnippet || "",
      body.sourceUrl || ""
    );

    const company = (
      body.company ||
      detected.defaultCompany ||
      "Career Portal Employer"
    ).trim();
    const role = (body.role || "Software Engineer").trim();
    const portal = body.portal || detected.portal;
    const portalApplicationId =
      body.portalApplicationId ||
      extractApplicationId(
        `${body.portalApplicationId || ""} ${body.sourceUrl || ""} ${
          body.pageTextSnippet || ""
        }`
      );

    const result = createOrDeduplicateApplication({
      company,
      role,
      portal,
      portalApplicationId,
      sourceUrl: body.sourceUrl || null,
      location: body.location || "Bengaluru, India",
      status: body.status || "APPLIED",
      notes:
        body.notes ||
        `Captured via user-authorized CareerOS Chrome Extension from ${
          body.sourceUrl || portal
        }.`,
      source: "CHROME_EXTENSION",
    });

    return NextResponse.json(
      {
        ok: true,
        deduplicated: result.deduplicated,
        application: result.application,
      },
      { status: result.deduplicated ? 200 : 201, headers: corsHeaders }
    );
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Extension capture request failed",
      },
      { status: 500, headers: corsHeaders }
    );
  }
}
