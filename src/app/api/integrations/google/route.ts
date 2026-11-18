import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  getOAuthIntegrationStatus,
  ingestEmailMessage,
  listSyncedEmails,
} from "@/lib/db";
import {
  getGoogleOAuthUrl,
  getSampleBatchEmails,
  syncLiveGmailMessages,
  syncLiveGoogleCalendar,
} from "@/lib/google-integration";
import {
  createOAuthStateToken,
  OAUTH_STATE_COOKIE_NAME,
  requireAuthenticatedSession,
} from "@/lib/security";
import {
  validateOptionalIsoDate,
  validateOptionalString,
  validateRequiredString,
  ValidationError,
} from "@/lib/validation";

export async function GET(req: NextRequest) {
  const { session, errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse || !session) return errorResponse!;

  const status = getOAuthIntegrationStatus();
  const { stateToken, nonce } = createOAuthStateToken(session.jti, 600);
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
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  return res;
}

export async function POST(req: NextRequest) {
  const { errorResponse } = requireAuthenticatedSession(req);
  if (errorResponse) return errorResponse;

  try {
    const body = (await req.json()) as {
      action?:
        | "sync_gmail"
        | "sync_calendar"
        | "ingest_raw_email"
        | "simulate_sync";
      rawEmail?: Record<string, unknown>;
    };

    if (body.action === "sync_gmail") {
      const res = await syncLiveGmailMessages();
      return NextResponse.json(res);
    }

    if (body.action === "sync_calendar") {
      const res = await syncLiveGoogleCalendar();
      return NextResponse.json(res);
    }

    if (body.action === "ingest_raw_email") {
      if (!body.rawEmail || typeof body.rawEmail !== "object") {
        return NextResponse.json(
          { error: "rawEmail object is required." },
          { status: 400 }
        );
      }

      const subject = validateRequiredString(
        body.rawEmail.subject,
        "subject",
        300
      );
      const bodyText = validateRequiredString(
        body.rawEmail.bodyText,
        "bodyText",
        10000
      );
      const sender =
        validateOptionalString(body.rawEmail.sender, "sender", 200) ||
        "careers@company.com";
      const messageId =
        validateOptionalString(body.rawEmail.messageId, "messageId", 160) ||
        `msg_manual_${crypto.randomUUID().slice(0, 10)}`;
      const receivedAt =
        validateOptionalIsoDate(body.rawEmail.receivedAt, "receivedAt") ||
        new Date().toISOString();

      const result = ingestEmailMessage({
        messageId,
        subject,
        sender,
        receivedAt,
        bodyText,
        isSample: false,
      });

      return NextResponse.json({
        mode: "email_parser_ingestion",
        result,
      });
    }

    if (body.action === "simulate_sync") {
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
