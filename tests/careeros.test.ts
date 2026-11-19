import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { NextRequest } from "next/server";

// Configure isolated temporary SQLite database for tests (with sample data disabled by default)
const tempDbPath = path.join(
  os.tmpdir(),
  `careeros-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
);
process.env.CAREEROS_DB_PATH = tempDbPath;
delete process.env.CAREEROS_MASTER_PASSWORD;
delete process.env.CAREEROS_ENABLE_SAMPLE_DATA;

import {
  createOAuthStateToken,
  createSessionToken,
  decryptSecret,
  encryptSecret,
  hashPassword,
  isMasterPasswordConfigured,
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  verifyOAuthStateToken,
  verifyPassword,
  verifySessionToken,
} from "../src/lib/security.ts";
import {
  escapeSafeCsvCell,
  validateApplicationPortal,
  validateApplicationStatus,
  validateSafeHttpUrl,
  ValidationError,
} from "../src/lib/validation.ts";
import {
  consumeOAuthStateNonce,
  createOrDeduplicateApplication,
  getDb,
  getMasterPasswordHash,
  getOAuthIntegrationStatus,
  ingestEmailMessage,
  listApplications,
  listInterviews,
  listTimelineEvents,
  rotateExtensionApiToken,
  saveEncryptedOAuthToken,
  storeOAuthStateNonce,
} from "../src/lib/db.ts";
import {
  syncLiveGmailMessages,
  syncLiveGoogleCalendar,
} from "../src/lib/google-integration.ts";

// Import API route handlers for end-to-end HTTP security verification
import { GET as getAuth, POST as postAuth } from "../src/app/api/auth/route.ts";
import { GET as getDashboard } from "../src/app/api/dashboard/route.ts";
import {
  GET as getApplications,
  POST as postApplications,
  PATCH as patchApplications,
  DELETE as deleteApplications,
} from "../src/app/api/applications/route.ts";
import { GET as getHistory } from "../src/app/api/history/route.ts";
import {
  GET as getInterviews,
  POST as postInterviews,
  PATCH as patchInterviews,
} from "../src/app/api/interviews/route.ts";
import {
  GET as getBriefing,
  POST as postBriefing,
} from "../src/app/api/briefing/route.ts";
import {
  GET as getGoogleIntegration,
  POST as postGoogleIntegration,
} from "../src/app/api/integrations/google/route.ts";
import { GET as getGoogleCallback } from "../src/app/api/integrations/google/callback/route.ts";
import {
  OPTIONS as optionsExtensionCapture,
  POST as postExtensionCapture,
} from "../src/app/api/extension/capture/route.ts";

describe("CareerOS Security, Reliability & Integration Verification Suite", () => {
  before(() => {
    getDb();
  });

  it("1. Sample data isolation: fresh personal DB has zero unrequested sample applications or interviews", () => {
    assert.equal(
      listApplications().length,
      0,
      "Personal database should start empty when CAREEROS_ENABLE_SAMPLE_DATA is not 'true'"
    );
    assert.equal(listInterviews().length, 0);

    // Insert a sample-flagged application and sample interview email; neither should appear in default queries
    createOrDeduplicateApplication({
      company: "SampleDemoCorp",
      role: "Demo Engineer",
      portal: "Company Website",
      portalApplicationId: "DEMO-001",
      isSample: true,
    });
    ingestEmailMessage({
      messageId: "msg_sample_interview_isolated",
      subject:
        "Interview Invitation: Demo Engineer at SampleDemoCorp (Application ID: DEMO-001)",
      sender: "SampleDemoCorp Recruiting <careers@sampledemo.com>",
      receivedAt: new Date().toISOString(),
      bodyText:
        "Your interview for the role of Demo Engineer (Application ID: DEMO-001) is scheduled. Join https://meet.google.com/abc-defg-hij",
      isSample: true,
    });

    assert.equal(listApplications().length, 0);
    assert.equal(listInterviews().length, 0);
    assert.equal(listApplications({ includeSample: true }).length, 1);
    assert.equal(listInterviews(true, true).length, 1);
  });

  it("2. AES-256-GCM HKDF v2 OAuth token encryption, tamper protection, and weak env key fail-closed", () => {
    const rawToken = "ya29.a0AfH6SMBx-secret-google-oauth-token-2026";
    const encrypted = encryptSecret(rawToken);
    assert.ok(encrypted.startsWith("v2:"));
    assert.ok(!encrypted.includes(rawToken));

    const decrypted = decryptSecret(encrypted);
    assert.equal(decrypted, rawToken);

    const tampered = encrypted.slice(0, -4) + "ffff";
    assert.throws(() => decryptSecret(tampered));

    // Verify weak explicit env key fails closed rather than silently falling back
    process.env.CAREEROS_ENCRYPTION_KEY = "too-short";
    try {
      assert.throws(() => encryptSecret("test"), /at least 32 characters/i);
    } finally {
      delete process.env.CAREEROS_ENCRYPTION_KEY;
    }
  });

  it("3. Removal of insecure fallback passwords & unauthenticated /api/auth metadata hygiene", async () => {
    assert.equal(isMasterPasswordConfigured(getMasterPasswordHash()), false);
    assert.equal(verifyPassword("careeros-admin-2026", null), false);

    const hashed = hashPassword("MyStrongPersonalVaultPass!2026");
    assert.equal(verifyPassword("MyStrongPersonalVaultPass!2026", hashed), true);
    assert.equal(verifyPassword("wrong-password", hashed), false);

    const authStatusRes = await getAuth(
      new NextRequest("http://localhost:3000/api/auth", { method: "GET" })
    );
    const authJson = (await authStatusRes.json()) as Record<string, unknown>;
    assert.equal(authJson.authenticated, false);
    assert.equal(authJson.csrfToken, null);
    assert.equal(
      authJson.extensionTokenConfigured,
      null,
      "Must not expose extensionTokenConfigured to unauthenticated callers"
    );
  });

  it("4. OAuth state generation, browser-session JTI binding, single-use nonce consumption, and expiry", () => {
    const sessionToken = createSessionToken(3600);
    const session = verifySessionToken(sessionToken)!;
    assert.ok(session);

    const { stateToken, nonce, expiresAt } = createOAuthStateToken(
      session.jti,
      600
    );
    storeOAuthStateNonce(nonce, session.jti, expiresAt);

    const check = verifyOAuthStateToken(stateToken, session.jti, nonce);
    assert.equal(check.valid, true);
    assert.equal(check.nonce, nonce);

    // Single-use consumption succeeds once, then rejects replay
    assert.equal(consumeOAuthStateNonce(nonce, session.jti), true);
    assert.equal(consumeOAuthStateNonce(nonce, session.jti), false);

    // Reject if bound to a different browser session JTI or wrong nonce
    assert.equal(
      verifyOAuthStateToken(stateToken, "different-session-jti", nonce).valid,
      false
    );
    assert.equal(
      verifyOAuthStateToken(stateToken, session.jti, "wrong-nonce").valid,
      false
    );

    // Reject if expired
    const expired = createOAuthStateToken(session.jti, -10);
    assert.equal(
      verifyOAuthStateToken(expired.stateToken, session.jti, expired.nonce)
        .valid,
      false
    );
  });

  it("5. Input payload, allowed enum, URL scheme, and CSV formula injection validation", () => {
    assert.equal(validateApplicationStatus("INTERVIEW"), "INTERVIEW");
    assert.throws(
      () => validateApplicationStatus("INVALID_STATUS"),
      ValidationError
    );

    assert.equal(validateApplicationPortal("Amazon Careers"), "Amazon Careers");
    assert.throws(
      () => validateApplicationPortal("UnknownPortal"),
      ValidationError
    );

    assert.equal(
      validateSafeHttpUrl("https://www.amazon.jobs/en/jobs/123"),
      "https://www.amazon.jobs/en/jobs/123"
    );
    assert.throws(
      () => validateSafeHttpUrl("javascript:alert(document.cookie)"),
      ValidationError
    );

    // CSV formula injection mitigation
    assert.equal(escapeSafeCsvCell("=SUM(A1:A2)"), `"'=SUM(A1:A2)"`);
    assert.equal(escapeSafeCsvCell("+cmd|' /C calc'!A0"), `"'+cmd|' /C calc'!A0"`);
    assert.equal(escapeSafeCsvCell("Normal Company"), `"Normal Company"`);
  });

  it("6. Unauthorized requests to EVERY private API route return HTTP 401 without exposing data or mutating state", async () => {
    const unauthGet = (url: string) =>
      new NextRequest(new URL(url, "http://localhost:3000"), { method: "GET" });
    const unauthReq = (method: string, url: string, body?: unknown) =>
      new NextRequest(new URL(url, "http://localhost:3000"), {
        method,
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

    assert.equal((await getDashboard(unauthGet("/api/dashboard"))).status, 401);
    assert.equal(
      (await getApplications(unauthGet("/api/applications"))).status,
      401
    );
    assert.equal(
      (
        await postApplications(
          unauthReq("POST", "/api/applications", {
            company: "UnauthCorp",
            role: "Engineer",
          })
        )
      ).status,
      401
    );
    assert.equal(
      (
        await patchApplications(
          unauthReq("PATCH", "/api/applications", { id: "app_1", status: "OFFER" })
        )
      ).status,
      401
    );
    assert.equal(
      (
        await deleteApplications(
          unauthReq("DELETE", "/api/applications?id=app_1")
        )
      ).status,
      401
    );
    assert.equal((await getHistory(unauthGet("/api/history"))).status, 401);
    assert.equal(
      (await getInterviews(unauthGet("/api/interviews"))).status,
      401
    );
    assert.equal(
      (
        await postInterviews(
          unauthReq("POST", "/api/interviews", {
            company: "UnauthCorp",
            role: "Engineer",
            roundName: "R1",
            scheduledStart: new Date().toISOString(),
          })
        )
      ).status,
      401
    );
    assert.equal(
      (
        await patchInterviews(
          unauthReq("PATCH", "/api/interviews", {
            id: "int_1",
            status: "COMPLETED",
          })
        )
      ).status,
      401
    );
    assert.equal((await getBriefing(unauthGet("/api/briefing"))).status, 401);
    assert.equal(
      (await postBriefing(unauthReq("POST", "/api/briefing", {}))).status,
      401
    );
    assert.equal(
      (await getGoogleIntegration(unauthGet("/api/integrations/google")))
        .status,
      401
    );
    assert.equal(
      (
        await postGoogleIntegration(
          unauthReq("POST", "/api/integrations/google", { action: "sync_gmail" })
        )
      ).status,
      401
    );
    assert.equal(
      (
        await getGoogleCallback(
          unauthGet(
            "/api/integrations/google/callback?code=123&state=fake_state"
          )
        )
      ).status,
      401
    );
    assert.equal(
      (
        await postExtensionCapture(
          unauthReq("POST", "/api/extension/capture", {
            company: "UnauthExt",
            role: "Dev",
          })
        )
      ).status,
      401
    );

    assert.equal(listApplications().length, 0);
  });

  it("7. Full auth lifecycle, CSRF enforcement, CRUD + Delete, Chrome Extension security, Immutable History & Server-Side Logout Revocation", async () => {
    // Cross-origin setup must be blocked with 403
    const crossOriginSetup = new NextRequest("http://localhost:3000/api/auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({
        action: "setup",
        password: "VaultMasterPassword#2026",
      }),
    });
    assert.equal((await postAuth(crossOriginSetup)).status, 403);

    // Same-origin initial setup succeeds
    const setupRes = await postAuth(
      new NextRequest("http://localhost:3000/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          action: "setup",
          password: "VaultMasterPassword#2026",
        }),
      })
    );
    assert.equal(setupRes.status, 200);

    // Invalid action returns 400
    assert.equal(
      (
        await postAuth(
          new NextRequest("http://localhost:3000/api/auth", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
            },
            body: JSON.stringify({ action: "unknown_action" }),
          })
        )
      ).status,
      400
    );

    // Malformed JSON returns 400 (not 500)
    assert.equal(
      (
        await postAuth(
          new NextRequest("http://localhost:3000/api/auth", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
            },
            body: "{not-valid-json",
          })
        )
      ).status,
      400
    );

    // Wrong password returns 401
    assert.equal(
      (
        await postAuth(
          new NextRequest("http://localhost:3000/api/auth", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
            },
            body: JSON.stringify({
              action: "login",
              password: "WrongPassword123",
            }),
          })
        )
      ).status,
      401
    );

    // Valid login returns session cookie + CSRF token
    const loginRes = await postAuth(
      new NextRequest("http://localhost:3000/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          action: "login",
          password: "VaultMasterPassword#2026",
        }),
      })
    );
    assert.equal(loginRes.status, 200);
    const loginJson = (await loginRes.json()) as { csrfToken: string };
    const sessionCookie = loginRes.cookies.get(SESSION_COOKIE_NAME)?.value;
    assert.ok(sessionCookie);
    assert.ok(loginJson.csrfToken);

    // Missing CSRF token on cookie-authenticated mutation returns 403 even with same-origin
    assert.equal(
      (
        await postApplications(
          new NextRequest("http://localhost:3000/api/applications", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
              Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
            },
            body: JSON.stringify({ company: "NoCsrfCorp", role: "Engineer" }),
          })
        )
      ).status,
      403
    );

    // Mismatched Origin returns 403 EVEN IF CSRF token is supplied
    assert.equal(
      (
        await postApplications(
          new NextRequest("http://localhost:3000/api/applications", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "https://evil.example.com",
              "X-CareerOS-CSRF": loginJson.csrfToken,
              Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
            },
            body: JSON.stringify({ company: "EvilOriginCorp", role: "Engineer" }),
          })
        )
      ).status,
      403
    );

    // Authenticated Application CRUD (POST -> GET -> PATCH -> Interview -> History -> DELETE)
    const createAppRes = await postApplications(
      new NextRequest("http://localhost:3000/api/applications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          "X-CareerOS-CSRF": loginJson.csrfToken,
          Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        },
        body: JSON.stringify({
          company: "Amazon",
          role: "Software Development Engineer I",
          portal: "Amazon Careers",
          portalApplicationId: "AMZN-LIVE-1001",
          sourceUrl: "https://www.amazon.jobs/en/jobs/1001",
          recruiterEmail: "recruiting@amazon.com",
          status: "APPLIED",
        }),
      })
    );
    assert.equal(createAppRes.status, 201);
    const createdAppData = (await createAppRes.json()) as {
      application: { id: string; status: string };
    };

    // PATCH status transition
    assert.equal(
      (
        await patchApplications(
          new NextRequest("http://localhost:3000/api/applications", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
              "X-CareerOS-CSRF": loginJson.csrfToken,
              Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
            },
            body: JSON.stringify({
              id: createdAppData.application.id,
              status: "ASSESSMENT",
              reasonNote: "Received Amazon OA invite",
            }),
          })
        )
      ).status,
      200
    );

    // POST interview linked to application
    const intRes = await postInterviews(
      new NextRequest("http://localhost:3000/api/interviews", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          "X-CareerOS-CSRF": loginJson.csrfToken,
          Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        },
        body: JSON.stringify({
          applicationId: createdAppData.application.id,
          company: "Amazon",
          role: "Software Development Engineer I",
          roundName: "Technical Loop Round 1",
          scheduledStart: new Date(Date.now() + 86400000).toISOString(),
          meetingLink: "https://chime.aws/123456",
        }),
      })
    );
    assert.equal(intRes.status, 201);

    // GET history CSV export & verify SQLite triggers block UPDATE/DELETE
    const csvRes = await getHistory(
      new NextRequest("http://localhost:3000/api/history?export=csv", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      })
    );
    assert.equal(csvRes.status, 200);
    const csvText = await csvRes.text();
    assert.ok(csvText.includes("Amazon"));

    const events = listTimelineEvents({
      applicationId: createdAppData.application.id,
    });
    assert.equal(events.length, 3); // Created + Assessment + Interview
    const db = getDb();
    assert.throws(() => {
      db.prepare(
        `UPDATE application_timeline_events SET title = 'Tampered' WHERE id = ?`
      ).run(events[0].id);
    }, /immutable/i);
    assert.throws(() => {
      db.prepare(`DELETE FROM application_timeline_events WHERE id = ?`).run(
        events[0].id
      );
    }, /immutable/i);

    // DELETE active application preserves immutable history
    const delRes = await deleteApplications(
      new NextRequest(
        `http://localhost:3000/api/applications?id=${createdAppData.application.id}`,
        {
          method: "DELETE",
          headers: {
            Origin: "http://localhost:3000",
            "X-CareerOS-CSRF": loginJson.csrfToken,
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
          },
        }
      )
    );
    assert.equal(delRes.status, 200);
    assert.equal(
      listTimelineEvents({ applicationId: createdAppData.application.id })
        .length,
      4
    );

    // Chrome Extension API: untrusted Origin blocked with 403, invalid token returns 401
    const preflightRes = await optionsExtensionCapture(
      new NextRequest("http://localhost:3000/api/extension/capture", {
        method: "OPTIONS",
        headers: { Origin: "https://untrusted-site.example.com" },
      })
    );
    assert.equal(preflightRes.status, 403);
    assert.equal(preflightRes.headers.get("Access-Control-Allow-Origin"), null);

    assert.equal(
      (
        await postExtensionCapture(
          new NextRequest("http://localhost:3000/api/extension/capture", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CareerOS-Extension-Token": "invalid-token",
              Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
            },
            body: JSON.stringify({ company: "BadToken", role: "Dev" }),
          })
        )
      ).status,
      401
    );

    const extToken = rotateExtensionApiToken();
    const extCaptureRes = await postExtensionCapture(
      new NextRequest("http://localhost:3000/api/extension/capture", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CareerOS-Extension-Token": extToken,
        },
        body: JSON.stringify({
          company: "Infosys",
          role: "Specialist Programmer",
          portal: "Infosys",
          portalApplicationId: "INFY-LIVE-2002",
          sourceUrl: "https://careers.infosys.com/jobs/2002",
          status: "APPLIED",
        }),
      })
    );
    assert.equal(extCaptureRes.status, 201);

    // Logout revokes session server-side; replaying the old cookie returns 401!
    const logoutRes = await postAuth(
      new NextRequest("http://localhost:3000/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          "X-CareerOS-CSRF": loginJson.csrfToken,
          Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        },
        body: JSON.stringify({ action: "logout" }),
      })
    );
    assert.equal(logoutRes.status, 200);

    const replayAfterLogout = await getDashboard(
      new NextRequest("http://localhost:3000/api/dashboard", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      })
    );
    assert.equal(
      replayAfterLogout.status,
      401,
      "Replaying a logged-out session cookie must be rejected server-side with HTTP 401"
    );
  });

  it("8. Paginated & incremental Gmail sync, out-of-order status protection, non-job filtering, Calendar sync & revoked token handling", async () => {
    saveEncryptedOAuthToken({
      accountEmail: "owner@example.com",
      accessToken: "ya29.valid-test-access-token",
      refreshToken: "1//valid-test-refresh-token",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
      ],
      expiresInSeconds: 3600,
    });

    const originalFetch = globalThis.fetch;
    let messageDetailFetchCount = 0;
    try {
      // Mock 2-page Gmail list returning newest-first (Page 1: ASSESSMENT + non-job newsletter; Page 2: older APPLIED confirmation)
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/gmail/v1/users/me/messages?")) {
          if (url.includes("pageToken=page_2")) {
            return new Response(
              JSON.stringify({
                messages: [{ id: "gmail_msg_older_apply", threadId: "thr_1" }],
              }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              messages: [
                { id: "gmail_msg_newer_assess", threadId: "thr_1" },
                { id: "gmail_msg_non_job", threadId: "thr_spam" },
              ],
              nextPageToken: "page_2",
            }),
            { status: 200 }
          );
        }

        if (url.includes("/gmail/v1/users/me/messages/gmail_msg_newer_assess")) {
          messageDetailFetchCount++;
          return new Response(
            JSON.stringify({
              id: "gmail_msg_newer_assess",
              threadId: "thr_1",
              internalDate: String(Date.now()),
              payload: {
                headers: [
                  {
                    name: "Subject",
                    value:
                      "Online Assessment Invitation: TCS Digital Specialist Engineer (Ref: CT20261112223)",
                  },
                  {
                    name: "From",
                    value: "TCS NextStep <nextstep.support@tcs.com>",
                  },
                ],
                body: {
                  data: Buffer.from(
                    "Please complete your online coding assessment for Digital Specialist Engineer (CT20261112223) before deadline: 2026-11-28.",
                    "utf8"
                  ).toString("base64url"),
                },
              },
            }),
            { status: 200 }
          );
        }

        if (url.includes("/gmail/v1/users/me/messages/gmail_msg_non_job")) {
          messageDetailFetchCount++;
          return new Response(
            JSON.stringify({
              id: "gmail_msg_non_job",
              threadId: "thr_spam",
              internalDate: String(Date.now()),
              payload: {
                headers: [
                  { name: "Subject", value: "Your Amazon Prime package shipped!" },
                  { name: "From", value: "orders@shop.example.com" },
                ],
                body: {
                  data: Buffer.from(
                    "Your coffee mug will arrive tomorrow.",
                    "utf8"
                  ).toString("base64url"),
                },
              },
            }),
            { status: 200 }
          );
        }

        if (url.includes("/gmail/v1/users/me/messages/gmail_msg_older_apply")) {
          messageDetailFetchCount++;
          return new Response(
            JSON.stringify({
              id: "gmail_msg_older_apply",
              threadId: "thr_1",
              internalDate: String(Date.now() - 3 * 86400 * 1000),
              payload: {
                headers: [
                  {
                    name: "Subject",
                    value:
                      "TCS NextStep Application Received - Reference ID: CT20261112223",
                  },
                  {
                    name: "From",
                    value: "TCS NextStep <nextstep.support@tcs.com>",
                  },
                ],
                body: {
                  data: Buffer.from(
                    "Thank you for applying to Tata Consultancy Services for Digital Specialist Engineer (Ref: CT20261112223).",
                    "utf8"
                  ).toString("base64url"),
                },
              },
            }),
            { status: 200 }
          );
        }

        if (url.includes("/calendar/v3/calendars/primary/events")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "gcal_evt_1",
                  summary: "Technical Interview with TCS - Digital Specialist Engineer",
                  description: "Panel interview via Google Meet",
                  hangoutLink: "https://meet.google.com/tcs-int-2026",
                  organizer: { email: "panel@tcs.com" },
                  start: {
                    dateTime: new Date(Date.now() + 2 * 86400000).toISOString(),
                  },
                  end: {
                    dateTime: new Date(
                      Date.now() + 2 * 86400000 + 3600000
                    ).toISOString(),
                  },
                },
              ],
            }),
            { status: 200 }
          );
        }

        return new Response("Not Found", { status: 404 });
      };

      const appsBefore = listApplications().length;
      const sync1 = await syncLiveGmailMessages({ maxPages: 3, pageSize: 10 });
      assert.equal(sync1.pagesFetched, 2);
      assert.equal(sync1.newApplications, 1);
      assert.equal(sync1.deduplicatedCount, 1);
      assert.equal(sync1.skippedNonJobCount, 1);
      assert.equal(listApplications().length, appsBefore + 1);

      // Verify older Page 2 confirmation did NOT downgrade Page 1's ASSESSMENT status to APPLIED!
      const tcsApp = listApplications().find(
        (a) => a.portalApplicationId === "CT20261112223"
      );
      assert.equal(tcsApp?.status, "ASSESSMENT");

      // Repeat sync skips already-synced Gmail message IDs WITHOUT calling messages.get again!
      const fetchesBeforeRepeat = messageDetailFetchCount;
      const sync2 = await syncLiveGmailMessages({ maxPages: 3, pageSize: 10 });
      assert.equal(sync2.newApplications, 0);
      assert.equal(sync2.deduplicatedCount, 2);
      // Only the skipped non-job message was re-checked; the 2 synced job message IDs were skipped pre-fetch!
      assert.equal(messageDetailFetchCount, fetchesBeforeRepeat + 1);

      // Google Calendar sync imports interview & deduplicates on repeat sync
      const cal1 = await syncLiveGoogleCalendar();
      assert.equal(cal1.interviewsSynced, 1);
      const cal2 = await syncLiveGoogleCalendar();
      assert.equal(cal2.interviewsSynced, 0);

      // Expired token with revoked refresh token (400 invalid_grant) marks token REVOKED safely
      saveEncryptedOAuthToken({
        accountEmail: "owner@example.com",
        accessToken: "ya29.expired-token",
        refreshToken: "1//revoked-refresh-token",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        expiresInSeconds: -60,
      });

      process.env.GOOGLE_CLIENT_ID = "test-oauth-client-id";
      process.env.GOOGLE_CLIENT_SECRET = "test-oauth-client-secret";
      try {
        globalThis.fetch = async () =>
          new Response(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "Token has been expired or revoked.",
            }),
            { status: 400 }
          );

        await assert.rejects(
          () => syncLiveGmailMessages(),
          /expired or was revoked/i
        );
      } finally {
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
      }

      const statusAfterRevoke = getOAuthIntegrationStatus();
      assert.equal(statusAfterRevoke.tokenStatus, "REVOKED");
      assert.ok(statusAfterRevoke.lastSyncError?.includes("400"));
      assert.ok(statusAfterRevoke.lastSyncErrorAt);
    } finally {
      globalThis.fetch = originalFetch;
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // ignore cleanup on Windows
      }
    }
  });
});
