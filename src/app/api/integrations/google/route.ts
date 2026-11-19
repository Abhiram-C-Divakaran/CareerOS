import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  getDb,
  getOAuthIntegrationStatus,
  ingestEmailMessage,
  listSyncedEmails,
  storeOAuthStateNonce,
} from "@/lib/db";
import {
  getGoogleOAuthUrl,
  getSampleBatchEmails,
  syncLiveGmailMessages,
  syncLiveGoogleCalendar,
} from "@/lib/google-integration";
import {
  createOAuthStateToken,
  isSecureCookieContext,
  OAUTH_STATE_COOKIE_NAME,
  requireAuthenticatedSession,
} from "@/lib/security";
import {
  safeParseJsonBody,
  validateOptionalIsoDate,
  validateOptionalString,
  validateRequiredString,
  ValidationError,
} from "@/lib/validation";

export async function GET(req: NextRequest) {
  getDb();
  const { session, errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse || !session) return errorResponse!;

  const status = getOAuthIntegrationStatus();
  const { stateToken, nonce, expiresAt } = createOAuthStateToken(
    session.jti,
    600
  );
  storeOAuthStateNonce(nonce, session.jti, expiresAt);
  const oauthUrlInfo = getGoogleOAuthUrl(stateToken);
  const syncedEmails = listSyncedEmails();

  const res = NextResponse.json({
    status,
    oauthUrlInfo,
    syncedEmails,
  });

  res.cookies.set(OAUTH_STATE_COOKIE_NAME, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureCookieContext(req),
    path: "/",
    maxAge: 600,
  });

  return res;
}

export async function POST(req: NextRequest) {
  getDb();
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  try {
    const body = await safeParseJsonBody(req);
    const action = body.action;

    if (action === "sync_gmail") {
      const res = await syncLiveGmailMessages();
      return NextResponse.json(res);
    }

    if (action === "sync_calendar") {
      const res = await syncLiveGoogleCalendar();
      return NextResponse.json(res);
    }

    if (action === "ingest_raw_email") {
      const rawEmail = body.rawEmail as Record<string, unknown> | undefined;
      if (!rawEmail || typeof rawEmail !== "object") {
        return NextResponse.json(
          { error: "rawEmail object is required." },
          { status: 400 }
        );
      }

      const subject = validateRequiredString(rawEmail.subject, "subject", 300);
      const bodyText = validateRequiredString(
        rawEmail.bodyText,
        "bodyText",
        10000
      );
      const sender =
        validateOptionalString(rawEmail.sender, "sender", 200) ||
        "careers@company.com";
      const messageId =
        validateOptionalString(rawEmail.messageId, "messageId", 160) ||
        `msg_manual_${crypto.randomUUID().slice(0, 10)}`;
      const receivedAt =
        validateOptionalIsoDate(rawEmail.receivedAt, "receivedAt") ||
        new Date().toISOString();
      const isSample = Boolean(rawEmail.isSample);

      const result = ingestEmailMessage({
        messageId,
        subject,
        sender,
        receivedAt,
        bodyText,
        isSample,
      });

      return NextResponse.json({
        mode: "email_parser_ingestion",
        result,
      });
    }

    if (action === "simulate_sync") {
      const sampleBatch = getSampleBatchEmails();
      const results = sampleBatch.map((email) => ingestEmailMessage(email));

      return NextResponse.json({
        mode: "test_batch_sync",
        processedCount: results.length,
        deduplicatedMessages: results.filter((r) => r.deduplicatedMessage)
          .length,
        deduplicatedApplications: results.filter(
          (r) => r.deduplicatedApplication
        ).length,
        results,
      });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Google integration synchronization failed",
      },
      { status: 400 }
    );
  }
}
