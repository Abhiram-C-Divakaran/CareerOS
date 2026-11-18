import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  getOAuthIntegrationStatus,
  ingestEmailMessage,
  listSyncedEmails,
  recordSyncTimestamp,
} from "@/lib/db";
import {
  getGoogleOAuthUrl,
  getSampleBatchEmails,
  syncLiveGmailMessages,
  syncLiveGoogleCalendar,
} from "@/lib/google-integration";

export async function GET() {
  const status = getOAuthIntegrationStatus();
  const state = crypto.randomBytes(16).toString("hex");
  const oauthUrlInfo = getGoogleOAuthUrl(state);
  const syncedEmails = listSyncedEmails();

  return NextResponse.json({
    status,
    oauthUrlInfo,
    syncedEmails,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action:
        | "sync_gmail"
        | "sync_calendar"
        | "ingest_raw_email"
        | "simulate_sync";
      rawEmail?: {
        messageId?: string;
        subject: string;
        sender: string;
        receivedAt?: string;
        bodyText: string;
      };
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
      if (!body.rawEmail?.subject || !body.rawEmail?.bodyText) {
        return NextResponse.json(
          { error: "Subject and bodyText are required to parse an email." },
          { status: 400 }
        );
      }

      const result = ingestEmailMessage({
        messageId:
          body.rawEmail.messageId?.trim() ||
          `msg_manual_${crypto.randomUUID().slice(0, 10)}`,
        subject: body.rawEmail.subject,
        sender: body.rawEmail.sender || "careers@company.com",
        receivedAt: body.rawEmail.receivedAt || new Date().toISOString(),
        bodyText: body.rawEmail.bodyText,
      });

      recordSyncTimestamp("gmail");

      return NextResponse.json({
        mode: "email_parser_ingestion",
        result,
      });
    }

    if (body.action === "simulate_sync") {
      const sampleBatch = getSampleBatchEmails();
      const results = sampleBatch.map((email) => ingestEmailMessage(email));
      recordSyncTimestamp("gmail");

      return NextResponse.json({
        mode: "test_batch_sync",
        processedCount: results.length,
        deduplicatedMessages: results.filter((r) => r.deduplicatedMessage).length,
        deduplicatedApplications: results.filter((r) => r.deduplicatedApplication).length,
        results,
      });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (err) {
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
