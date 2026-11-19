import { NextRequest, NextResponse } from "next/server";
import {
  createOrDeduplicateApplication,
  getDb,
  getExtensionTokenHash,
} from "@/lib/db";
import { detectPortalFromText, extractApplicationId } from "@/lib/email-parser";
import {
  getExtensionCorsHeaders,
  isOriginAllowedForExtension,
  requireAuthenticatedSession,
  verifyApiToken,
} from "@/lib/security";
import {
  safeParseJsonBody,
  validateApplicationPortal,
  validateApplicationStatus,
  validateOptionalString,
  validateRequiredString,
  validateSafeHttpUrl,
  ValidationError,
} from "@/lib/validation";

export async function OPTIONS(req: NextRequest) {
  const corsHeaders = getExtensionCorsHeaders(req);
  if (!isOriginAllowedForExtension(req)) {
    return new NextResponse(null, { status: 403, headers: corsHeaders });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  getDb();
  const corsHeaders = getExtensionCorsHeaders(req);

  if (!isOriginAllowedForExtension(req)) {
    return NextResponse.json(
      { error: "Origin not allowed for Chrome Extension capture API." },
      { status: 403, headers: corsHeaders }
    );
  }

  // Authenticate via either Extension API Token OR active browser session + CSRF check
  const extHeaderToken =
    req.headers.get("x-careeros-extension-token") ||
    (req.headers.get("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization")!.slice(7)
      : null);

  if (extHeaderToken !== null) {
    const storedExtHash = getExtensionTokenHash();
    if (!verifyApiToken(extHeaderToken, storedExtHash)) {
      return NextResponse.json(
        { error: "Invalid Chrome Extension API token." },
        { status: 401, headers: corsHeaders }
      );
    }
  } else {
    const { errorResponse } = requireAuthenticatedSession(req);
    if (errorResponse) {
      return NextResponse.json(
        {
          error:
            "Unauthorized extension capture request. Provide a valid X-CareerOS-Extension-Token or authenticated session.",
        },
        { status: errorResponse.status, headers: corsHeaders }
      );
    }
  }

  try {
    const body = await safeParseJsonBody(req);

    const pageTextSnippet =
      validateOptionalString(body.pageTextSnippet, "pageTextSnippet", 6000) ||
      "";
    const sourceUrl = validateSafeHttpUrl(body.sourceUrl, "sourceUrl");

    const detected = detectPortalFromText(
      "",
      `${String(body.company || "")} ${String(body.role || "")}`,
      pageTextSnippet,
      sourceUrl || ""
    );

    const company = validateRequiredString(
      body.company || detected.defaultCompany,
      "company",
      140
    );
    const role = validateRequiredString(body.role, "role", 160);
    const portal = body.portal
      ? validateApplicationPortal(body.portal)
      : detected.portal;
    const status = body.status
      ? validateApplicationStatus(body.status)
      : "APPLIED";
    const location =
      validateOptionalString(body.location, "location", 120) ||
      "Bengaluru, India";
    const notes = validateOptionalString(body.notes, "notes", 2000);

    const explicitPortalId = validateOptionalString(
      body.portalApplicationId,
      "portalApplicationId",
      80
    );
    const portalApplicationId =
      explicitPortalId ||
      extractApplicationId(
        `${explicitPortalId || ""} ${sourceUrl || ""} ${pageTextSnippet}`
      );

    const result = createOrDeduplicateApplication({
      company,
      role,
      portal,
      portalApplicationId,
      sourceUrl,
      location,
      status,
      notes:
        notes ||
        `Captured via user-authorized CareerOS Chrome Extension from ${
          sourceUrl || portal
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
    if (err instanceof ValidationError) {
      return NextResponse.json(
        { error: err.message },
        { status: 400, headers: corsHeaders }
      );
    }
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
