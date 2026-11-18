import {
  createOrUpdateInterview,
  getDecryptedGoogleTokens,
  ingestEmailMessage,
  recordOAuthSyncError,
  recordSyncTimestamp,
  saveEncryptedOAuthToken,
} from "./db.ts";
import {
  extractCompanyName,
  extractMeetingLink,
  extractRoleTitle,
  type RawEmailInput,
} from "./email-parser.ts";

export const GOOGLE_MINIMAL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function getGoogleOAuthUrl(state: string): {
  configured: boolean;
  url: string | null;
  setupInstructions?: string;
} {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    "http://localhost:3000/api/integrations/google/callback";

  if (!clientId || !clientSecret) {
    return {
      configured: false,
      url: null,
      setupInstructions:
        "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local (from Google Cloud Console -> APIs & Services -> Credentials) with Redirect URI http://localhost:3000/api/integrations/google/callback.",
    };
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_MINIMAL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });

  return {
    configured: true,
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  };
}

export async function exchangeGoogleCodeForTokens(code: string): Promise<{
  accountEmail: string;
  scopes: string[];
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    "http://localhost:3000/api/integrations/google/callback";

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET environment variables"
    );
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    recordOAuthSyncError(
      `OAuth token exchange failed (${tokenRes.status})`,
      "REVOKED"
    );
    throw new Error(`Google token exchange failed: ${tokenRes.status} ${errText}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!tokenData.access_token) {
    throw new Error("Google OAuth response did not include an access_token");
  }

  let accountEmail = "connected-user@gmail.com";
  try {
    const userRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      }
    );
    if (userRes.ok) {
      const profile = (await userRes.json()) as { email?: string };
      if (profile.email) accountEmail = profile.email;
    }
  } catch {
    // Keep fallback email if userinfo endpoint is unreachable
  }

  const scopes = tokenData.scope
    ? tokenData.scope.split(" ")
    : GOOGLE_MINIMAL_SCOPES;

  saveEncryptedOAuthToken({
    accountEmail,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || null,
    scopes,
    expiresInSeconds: tokenData.expires_in || 3600,
  });

  return { accountEmail, scopes };
}

export async function getValidAccessToken(): Promise<string> {
  const stored = getDecryptedGoogleTokens();
  if (!stored) {
    throw new Error(
      "Google OAuth account is not connected. Connect your Google account first."
    );
  }

  if (stored.tokenStatus === "REVOKED") {
    throw new Error(
      "Google OAuth token was revoked. Please reconnect your Google account."
    );
  }

  const isExpired =
    stored.tokenExpiresAt !== null &&
    new Date(stored.tokenExpiresAt).getTime() <= Date.now() + 60_000;

  if (!isExpired) {
    return stored.accessToken;
  }

  if (!stored.refreshToken) {
    recordOAuthSyncError(
      "Google access token expired and no refresh token is available. Please reconnect Google OAuth.",
      "EXPIRED"
    );
    throw new Error(
      "Google access token has expired and no refresh token is stored. Please reconnect Google OAuth."
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    recordOAuthSyncError(
      "Google access token expired and GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are missing for token refresh.",
      "EXPIRED"
    );
    throw new Error(
      "Google access token expired and OAuth client credentials are not configured for refresh."
    );
  }

  const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: stored.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!refreshRes.ok) {
    const errText = await refreshRes.text();
    const isRevoked =
      refreshRes.status === 400 ||
      refreshRes.status === 401 ||
      /invalid_grant|revoked/i.test(errText);
    recordOAuthSyncError(
      `Failed to refresh Google OAuth token (${refreshRes.status}): ${errText.slice(0, 200)}`,
      isRevoked ? "REVOKED" : "EXPIRED"
    );
    throw new Error(
      isRevoked
        ? "Google OAuth refresh token expired or was revoked. Please reconnect your Google account."
        : `Google token refresh failed with HTTP ${refreshRes.status}`
    );
  }

  const refreshed = (await refreshRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!refreshed.access_token) {
    recordOAuthSyncError(
      "Google token refresh response did not contain an access_token.",
      "EXPIRED"
    );
    throw new Error("Invalid token refresh response from Google.");
  }

  saveEncryptedOAuthToken({
    accountEmail: stored.accountEmail || "owner@gmail.com",
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || stored.refreshToken,
    scopes: GOOGLE_MINIMAL_SCOPES,
    expiresInSeconds: refreshed.expires_in || 3600,
  });

  return refreshed.access_token;
}

interface MimePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: MimePart[];
}

function extractMimeBodyText(payload?: MimePart, fallbackSnippet = ""): string {
  if (!payload) return fallbackSnippet;

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    try {
      return Buffer.from(payload.body.data, "base64url").toString("utf8");
    } catch {
      // continue
    }
  }

  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      const plain = extractMimeBodyText(part, "");
      if (plain) return plain;
    }
  }

  if (payload.body?.data) {
    try {
      const decoded = Buffer.from(payload.body.data, "base64url").toString("utf8");
      return decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    } catch {
      // fall through
    }
  }

  return fallbackSnippet;
}

/**
 * Paginated and incremental Gmail synchronization.
 * Preserves Gmail message IDs for strict deduplication and updates last_gmail_sync_at on success.
 */
export async function syncLiveGmailMessages(options?: {
  maxPages?: number;
  pageSize?: number;
}): Promise<{
  mode: "live_google_api";
  pagesFetched: number;
  processedCount: number;
  newApplications: number;
  deduplicatedCount: number;
  incrementalSince: string | null;
  syncedAt: string;
}> {
  const accessToken = await getValidAccessToken();
  const stored = getDecryptedGoogleTokens();
  const maxPages = Math.min(Math.max(options?.maxPages ?? 3, 1), 10);
  const pageSize = Math.min(Math.max(options?.pageSize ?? 25, 5), 100);

  // Build incremental query using last successful sync watermark (with 24h overlap for safety)
  let timeFilter = "newer_than:30d";
  let incrementalSince: string | null = null;
  if (stored?.lastGmailSyncAt) {
    const lastSyncMs = Date.parse(stored.lastGmailSyncAt);
    if (!Number.isNaN(lastSyncMs)) {
      const safeAfterSec = Math.max(
        0,
        Math.floor((lastSyncMs - 24 * 3600 * 1000) / 1000)
      );
      timeFilter = `after:${safeAfterSec}`;
      incrementalSince = new Date(safeAfterSec * 1000).toISOString();
    }
  }

  const baseQuery = `(subject:("application" OR "interview" OR "assessment" OR "offer" OR "NextStep" OR "Amazon" OR "Wipro" OR "Infosys" OR "Accenture" OR "LinkedIn" OR "Naukri")) ${timeFilter}`;

  let pageToken: string | undefined = undefined;
  let pagesFetched = 0;
  let processedCount = 0;
  let newApplications = 0;
  let deduplicatedCount = 0;

  try {
    do {
      const params = new URLSearchParams({
        q: baseQuery,
        maxResults: String(pageSize),
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }

      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!listRes.ok) {
        const errBody = await listRes.text();
        if (listRes.status === 401 || listRes.status === 403) {
          recordOAuthSyncError(
            `Gmail API authorization error (${listRes.status}): ${errBody.slice(0, 200)}`,
            listRes.status === 401 ? "REVOKED" : undefined
          );
        } else {
          recordOAuthSyncError(
            `Gmail API error (${listRes.status}): ${errBody.slice(0, 200)}`
          );
        }
        throw new Error(`Gmail API returned ${listRes.status}: ${errBody}`);
      }

      const listJson = (await listRes.json()) as {
        messages?: { id: string; threadId: string }[];
        nextPageToken?: string;
      };

      pagesFetched++;
      const messages = listJson.messages || [];

      for (const item of messages) {
        if (!item.id) continue;

        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
            item.id
          )}?format=full`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (!msgRes.ok) continue;

        const msgData = (await msgRes.json()) as {
          id: string;
          threadId: string;
          snippet?: string;
          internalDate?: string;
          payload?: MimePart & {
            headers?: { name: string; value: string }[];
          };
        };

        const headers = msgData.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
            ?.value || "";

        const subject = getHeader("Subject") || "Career Update";
        const sender = getHeader("From") || "careers@employer.com";
        const receivedAt = msgData.internalDate
          ? new Date(Number(msgData.internalDate)).toISOString()
          : new Date().toISOString();

        const bodyText = extractMimeBodyText(
          msgData.payload,
          msgData.snippet || ""
        );

        const result = ingestEmailMessage({
          messageId: msgData.id,
          threadId: msgData.threadId,
          subject,
          sender,
          receivedAt,
          bodyText,
          isSample: false,
        });

        processedCount++;
        if (result.deduplicatedMessage || result.deduplicatedApplication) {
          deduplicatedCount++;
        } else {
          newApplications++;
        }
      }

      pageToken = listJson.nextPageToken;
    } while (pageToken && pagesFetched < maxPages);

    recordSyncTimestamp("gmail");
    const syncedAt = new Date().toISOString();

    return {
      mode: "live_google_api",
      pagesFetched,
      processedCount,
      newApplications,
      deduplicatedCount,
      incrementalSince,
      syncedAt,
    };
  } catch (err) {
    if (err instanceof Error) {
      recordOAuthSyncError(err.message);
    }
    throw err;
  }
}

export async function syncLiveGoogleCalendar(): Promise<{
  mode: "live_google_api";
  eventsScanned: number;
  interviewsSynced: number;
  syncedAt: string;
}> {
  const accessToken = await getValidAccessToken();
  const timeMin = new Date().toISOString();

  let pageToken: string | undefined = undefined;
  let pagesFetched = 0;
  let eventsScanned = 0;
  let interviewsSynced = 0;

  try {
    do {
      const params = new URLSearchParams({
        timeMin,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "50",
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }

      const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!calRes.ok) {
        const errBody = await calRes.text();
        if (calRes.status === 401 || calRes.status === 403) {
          recordOAuthSyncError(
            `Google Calendar API authorization error (${calRes.status}): ${errBody.slice(0, 200)}`,
            calRes.status === 401 ? "REVOKED" : undefined
          );
        } else {
          recordOAuthSyncError(
            `Google Calendar API error (${calRes.status}): ${errBody.slice(0, 200)}`
          );
        }
        throw new Error(
          `Google Calendar API returned ${calRes.status}: ${errBody}`
        );
      }

      const calData = (await calRes.json()) as {
        items?: {
          id: string;
          summary?: string;
          description?: string;
          hangoutLink?: string;
          location?: string;
          organizer?: { email?: string; displayName?: string };
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
        }[];
        nextPageToken?: string;
      };

      pagesFetched++;
      const items = calData.items || [];
      eventsScanned += items.length;

      for (const ev of items) {
        const summary = ev.summary || "";
        const description = ev.description || "";
        const combined = `${summary}\n${description}`;

        if (
          !/interview|technical\s+round|hiring\s+manager|coding\s+round|system\s+design|loop|recruiter\s+screen|panel/i.test(
            combined
          )
        ) {
          continue;
        }

        const organizerEmail = ev.organizer?.email || "recruiting@company.com";
        const company = extractCompanyName(organizerEmail, summary, description);
        const role = extractRoleTitle(summary, description);
        const meetingLink =
          ev.hangoutLink ||
          extractMeetingLink(combined) ||
          (ev.location?.startsWith("http") ? ev.location : null);

        const scheduledStart =
          ev.start?.dateTime || ev.start?.date || new Date().toISOString();
        const scheduledEnd =
          ev.end?.dateTime ||
          ev.end?.date ||
          new Date(new Date(scheduledStart).getTime() + 3600000).toISOString();

        const res = createOrUpdateInterview({
          company,
          role,
          roundName: summary,
          scheduledStart,
          scheduledEnd,
          meetingLink,
          organizerEmail,
          calendarEventId: ev.id,
          prepNotes: description.slice(0, 300) || null,
          source: "CALENDAR_SYNC",
        });

        if (res.created) interviewsSynced++;
      }

      pageToken = calData.nextPageToken;
    } while (pageToken && pagesFetched < 3);

    recordSyncTimestamp("calendar");
    const syncedAt = new Date().toISOString();

    return {
      mode: "live_google_api",
      eventsScanned,
      interviewsSynced,
      syncedAt,
    };
  } catch (err) {
    if (err instanceof Error) {
      recordOAuthSyncError(err.message);
    }
    throw err;
  }
}

export function getSampleBatchEmails(): RawEmailInput[] {
  const now = Date.now();
  return [
    {
      messageId: "msg_sim_wipro_interview_2026",
      threadId: "thr_wipro_88412",
      subject:
        "Interview Invitation: Project Engineer (Wipro Turbo) at Wipro (Application ID: WPR-TURBO-88412)",
      sender: "Wipro Campus Hiring <campus.hiring@wipro.com>",
      receivedAt: new Date(now - 15 * 60 * 1000).toISOString(),
      bodyText:
        "Dear Candidate, Congratulations on clearing the Wipro Turbo coding assessment for Project Engineer (Application ID: WPR-TURBO-88412). Your technical interview is scheduled for 2026-11-20. Join via Microsoft Teams: https://teams.microsoft.com/l/meetup-join/wipro-turbo-tech-round",
      isSample: true,
    },
    {
      messageId: "msg_sim_razorpay_confirm_2026",
      threadId: "thr_rzp_101",
      subject:
        "Thank you for applying to Razorpay for the role of Senior Frontend Engineer (Job ID: RZP-FE-90412)",
      sender: "Razorpay Talent Acquisition <careers@razorpay.com>",
      receivedAt: new Date(now - 5 * 60 * 1000).toISOString(),
      bodyText:
        "We have received your application at Razorpay for the position of Senior Frontend Engineer. Your Reference ID is RZP-FE-90412. Our engineering hiring team will review your profile shortly.",
      isSample: true,
    },
  ];
}
