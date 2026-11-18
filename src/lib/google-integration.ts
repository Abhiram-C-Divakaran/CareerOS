import {
  createOrUpdateInterview,
  getDecryptedGoogleTokens,
  ingestEmailMessage,
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
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    "http://localhost:3000/api/integrations/google/callback";

  if (!clientId) {
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
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
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
    throw new Error(`Google token exchange failed: ${tokenRes.status} ${errText}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

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

async function getValidAccessToken(): Promise<string | null> {
  const stored = getDecryptedGoogleTokens();
  if (!stored) return null;

  if (
    stored.tokenExpiresAt &&
    new Date(stored.tokenExpiresAt).getTime() > Date.now() + 60_000
  ) {
    return stored.accessToken;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!stored.refreshToken || !clientId || !clientSecret) {
    return stored.accessToken;
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
    return stored.accessToken;
  }

  const refreshed = (await refreshRes.json()) as {
    access_token: string;
    expires_in?: number;
  };

  saveEncryptedOAuthToken({
    accountEmail: stored.accountEmail || "owner@gmail.com",
    accessToken: refreshed.access_token,
    refreshToken: stored.refreshToken,
    scopes: GOOGLE_MINIMAL_SCOPES,
    expiresInSeconds: refreshed.expires_in || 3600,
  });

  return refreshed.access_token;
}

export async function syncLiveGmailMessages(): Promise<{
  mode: "live_google_api";
  processedCount: number;
  newApplications: number;
  deduplicatedCount: number;
}> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error(
      "Google OAuth account is not connected yet. Connect Google OAuth or use the Test Email Ingestion Simulator."
    );
  }

  const query = encodeURIComponent(
    '(subject:("application" OR "interview" OR "assessment" OR "offer" OR "NextStep" OR "Amazon" OR "Wipro" OR "Infosys" OR "Accenture" OR "LinkedIn" OR "Naukri")) newer_than:30d'
  );
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=15`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!listRes.ok) {
    const errBody = await listRes.text();
    throw new Error(`Gmail API returned ${listRes.status}: ${errBody}`);
  }

  const listJson = (await listRes.json()) as {
    messages?: { id: string; threadId: string }[];
  };

  const messages = listJson.messages || [];
  let processedCount = 0;
  let newApplications = 0;
  let deduplicatedCount = 0;

  for (const item of messages) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`,
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
      payload?: {
        headers?: { name: string; value: string }[];
        body?: { data?: string };
        parts?: { mimeType?: string; body?: { data?: string } }[];
      };
    };

    const headers = msgData.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

    const subject = getHeader("Subject") || "Career Update";
    const sender = getHeader("From") || "careers@employer.com";
    const receivedAt = msgData.internalDate
      ? new Date(Number(msgData.internalDate)).toISOString()
      : new Date().toISOString();

    let bodyText = msgData.snippet || "";
    const rawData =
      msgData.payload?.body?.data ||
      msgData.payload?.parts?.find((p) => p.mimeType === "text/plain")?.body?.data;
    if (rawData) {
      try {
        bodyText = Buffer.from(rawData, "base64url").toString("utf8");
      } catch {
        // fallback to snippet
      }
    }

    const result = ingestEmailMessage({
      messageId: msgData.id,
      threadId: msgData.threadId,
      subject,
      sender,
      receivedAt,
      bodyText,
    });

    processedCount++;
    if (result.deduplicatedMessage || result.deduplicatedApplication) {
      deduplicatedCount++;
    } else {
      newApplications++;
    }
  }

  recordSyncTimestamp("gmail");

  return {
    mode: "live_google_api",
    processedCount,
    newApplications,
    deduplicatedCount,
  };
}

export async function syncLiveGoogleCalendar(): Promise<{
  mode: "live_google_api";
  eventsScanned: number;
  interviewsSynced: number;
}> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error(
      "Google OAuth account is not connected yet. Connect Google OAuth or add/simulate calendar invites."
    );
  }

  const timeMin = encodeURIComponent(new Date().toISOString());
  const calRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&singleEvents=true&orderBy=startTime&maxResults=25`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!calRes.ok) {
    const errBody = await calRes.text();
    throw new Error(`Google Calendar API returned ${calRes.status}: ${errBody}`);
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
  };

  const items = calData.items || [];
  let interviewsSynced = 0;

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

  recordSyncTimestamp("calendar");

  return {
    mode: "live_google_api",
    eventsScanned: items.length,
    interviewsSynced,
  };
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
        "Dear Abhiram, Congratulations on clearing the Wipro Turbo coding assessment for Project Engineer (Application ID: WPR-TURBO-88412). Your technical interview is scheduled for 2026-11-20. Join via Microsoft Teams: https://teams.microsoft.com/l/meetup-join/wipro-turbo-tech-round",
    },
    {
      messageId: "msg_sim_razorpay_confirm_2026",
      threadId: "thr_rzp_101",
      subject:
        "Thank you for applying to Razorpay for the role of Senior Frontend Engineer (Job ID: RZP-FE-90412)",
      sender: "Razorpay Talent Acquisition <careers@razorpay.com>",
      receivedAt: new Date(now - 5 * 60 * 1000).toISOString(),
      bodyText:
        "Hi Abhiram, We have received your application at Razorpay for the position of Senior Frontend Engineer. Your Reference ID is RZP-FE-90412. Our engineering hiring team will review your profile shortly.",
    },
  ];
}
