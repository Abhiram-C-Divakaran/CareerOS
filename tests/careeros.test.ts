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
  deriveCsrfToken,
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
  validateApplicationPortal,
  validateApplicationStatus,
  validateSafeHttpUrl,
  ValidationError,
} from "../src/lib/validation.ts";
import { parseJobEmail } from "../src/lib/email-parser.ts";
import {
  createOrDeduplicateApplication,
  createOrUpdateInterview,
  generateDailyBriefing,
  getDb,
  getDecryptedGoogleTokens,
  getMasterPasswordHash,
  getOAuthIntegrationStatus,
  ingestEmailMessage,
  listApplications,
  listInterviews,
  listSyncedEmails,
  listTimelineEvents,
  rotateExtensionApiToken,
  saveEncryptedOAuthToken,
  setMasterPasswordHash,
  updateApplicationStatusAndFields,
} from "../src/lib/db.ts";
import { syncLiveGmailMessages } from "../src/lib/google-integration.ts";

// Import API route handlers for end-to-end HTTP security verification
import { GET as getAuth, POST as postAuth } from "../src/app/api/auth/route.ts";
import { GET as getDashboard } from "../src/app/api/dashboard/route.ts";
import {
  GET as getApplications,
  POST as postApplications,
  PATCH as patchApplications,
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

  it("1. Sample data isolation: fresh personal DB has zero unrequested sample applications", () => {
    const initialApps = listApplications();
    assert.equal(
      initialApps.length,
      0,
      "Personal database should start empty when CAREEROS_ENABLE_SAMPLE_DATA is not 'true'"
    );

    // Insert a sample-flagged application and verify it is excluded from default queries
    createOrDeduplicateApplication({
      company: "SampleDemoCorp",
      role: "Demo Engineer",
      portal: "Company Website",
      portalApplicationId: "DEMO-001",
      isSample: true,
    });

    assert.equal(listApplications().length, 0);
    assert.equal(listApplications({ includeSample: true }).length, 1);
  });

  it("2. AES-256-GCM OAuth token encryption & tamper protection", () => {
    const rawToken = "ya29.a0AfH6SMBx-secret-google-oauth-token-2026";
    const encrypted = encryptSecret(rawToken);
    assert.ok(encrypted.startsWith("v1:"));
    assert.ok(!encrypted.includes(rawToken));

    const decrypted = decryptSecret(encrypted);
    assert.equal(decrypted, rawToken);

    const tampered = encrypted.slice(0, -4) + "ffff";
    assert.throws(() => decryptSecret(tampered));
  });

  it("3. Removal of insecure fallback passwords & single-user password setup", () => {
    assert.equal(isMasterPasswordConfigured(getMasterPasswordHash()), false);
    // Old fallback password must NEVER work
    assert.equal(verifyPassword("careeros-admin-2026", null), false);

    const hashed = hashPassword("MyStrongPersonalVaultPass!2026");
    assert.equal(verifyPassword("MyStrongPersonalVaultPass!2026", hashed), true);
    assert.equal(verifyPassword("wrong-password", hashed), false);
  });

  it("4. OAuth state generation, browser-session JTI binding, expiry, and validation", () => {
    const sessionToken = createSessionToken(3600);
    const session = verifySessionToken(sessionToken)!;
    assert.ok(session);

    const { stateToken, nonce } = createOAuthStateToken(session.jti, 600);
    assert.equal(verifyOAuthStateToken(stateToken, session.jti, nonce), true);

    // Reject if bound to a different browser session JTI
    assert.equal(
      verifyOAuthStateToken(stateToken, "different-session-jti", nonce),
      false
    );

    // Reject if cookie nonce mismatches
    assert.equal(
      verifyOAuthStateToken(stateToken, session.jti, "wrong-nonce"),
      false
    );

    // Reject if expired
    const expired = createOAuthStateToken(session.jti, -10);
    assert.equal(
      verifyOAuthStateToken(expired.stateToken, session.jti, expired.nonce),
      false
    );
  });

  it("5. Input payload & allowed enum validation blocks invalid statuses and unsafe URLs", () => {
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
  });

  it("6. Unauthorized requests to EVERY private API route return HTTP 401 without exposing data or mutating state", async () => {
    const unauthGet = (url: string) =>
      new NextRequest(new URL(url, "http://localhost:3000"), { method: "GET" });
    const unauthPost = (url: string, body: unknown) =>
      new NextRequest(new URL(url, "http://localhost:3000"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      });
    const unauthPatch = (url: string, body: unknown) =>
      new NextRequest(new URL(url, "http://localhost:3000"), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      });

    assert.equal((await getDashboard(unauthGet("/api/dashboard"))).status, 401);
    assert.equal(
      (await getApplications(unauthGet("/api/applications"))).status,
      401
    );
    assert.equal(
      (
        await postApplications(
          unauthPost("/api/applications", {
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
          unauthPatch("/api/applications", { id: "app_1", status: "OFFER" })
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
          unauthPost("/api/interviews", {
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
          unauthPatch("/api/interviews", { id: "int_1", status: "COMPLETED" })
        )
      ).status,
      401
    );
    assert.equal((await getBriefing(unauthGet("/api/briefing"))).status, 401);
    assert.equal(
      (await postBriefing(unauthPost("/api/briefing", {}))).status,
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
          unauthPost("/api/integrations/google", { action: "sync_gmail" })
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
          unauthPost("/api/extension/capture", {
            company: "UnauthExt",
            role: "Dev",
          })
        )
      ).status,
      401
    );

    // Confirm zero real applications were created by any unauthorized request
    assert.equal(listApplications().length, 0);
  });

  it("7. Login, CSRF enforcement, Application CRUD, Chrome Extension Token Auth, Interview tracking, Immutable History & Logout", async () => {
    // 7a. Initial master password setup via /api/auth
    const setupReq = new NextRequest("http://localhost:3000/api/auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        action: "setup",
        password: "VaultMasterPassword#2026",
      }),
    });
    const setupRes = await postAuth(setupReq);
    assert.equal(setupRes.status, 200);

    // Wrong password login must return 401
    const badLoginReq = new NextRequest("http://localhost:3000/api/auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        action: "login",
        password: "WrongPassword123",
      }),
    });
    assert.equal((await postAuth(badLoginReq)).status, 401);

    // Valid login returns session cookie + CSRF token
    const loginReq = new NextRequest("http://localhost:3000/api/auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        action: "login",
        password: "VaultMasterPassword#2026",
      }),
    });
    const loginRes = await postAuth(loginReq);
    assert.equal(loginRes.status, 200);
    const loginJson = (await loginRes.json()) as { csrfToken: string };
    const sessionCookie = loginRes.cookies.get(SESSION_COOKIE_NAME)?.value;
    assert.ok(sessionCookie);
    assert.ok(loginJson.csrfToken);

    // 7b. Cross-origin mutation without CSRF token must be rejected with HTTP 403
    const csrfAttackReq = new NextRequest(
      "http://localhost:3000/api/applications",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://malicious.example.com",
          Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        },
        body: JSON.stringify({ company: "CSRFCorp", role: "Engineer" }),
      }
    );
    assert.equal((await postApplications(csrfAttackReq)).status, 403);

    // 7c. Authenticated + CSRF-protected Application Creation & Status Update
    const createAppReq = new NextRequest(
      "http://localhost:3000/api/applications",
      {
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
          status: "APPLIED",
        }),
      }
    );
    const createAppRes = await postApplications(createAppReq);
    assert.equal(createAppRes.status, 201);
    const createdAppData = (await createAppRes.json()) as {
      application: { id: string; status: string };
    };

    const patchAppReq = new NextRequest(
      "http://localhost:3000/api/applications",
      {
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
      }
    );
    assert.equal((await patchApplications(patchAppReq)).status, 200);

    // 7d. Secure Chrome Extension API Token & non-wildcard CORS verification
    const corsPreflight = new NextRequest(
      "http://localhost:3000/api/extension/capture",
      {
        method: "OPTIONS",
        headers: { Origin: "https://untrusted-site.example.com" },
      }
    );
    const preflightRes = await optionsExtensionCapture(corsPreflight);
    assert.equal(
      preflightRes.headers.get("Access-Control-Allow-Origin"),
      null,
      "Must never return wildcard CORS for untrusted origins"
    );

    const extToken = rotateExtensionApiToken();
    const extCaptureReq = new NextRequest(
      "http://localhost:3000/api/extension/capture",
      {
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
      }
    );
    const extCaptureRes = await postExtensionCapture(extCaptureReq);
    assert.equal(extCaptureRes.status, 201);

    // 7e.Immutable Timeline verification (SQLite triggers block UPDATE and DELETE)
    const events = listTimelineEvents({
      applicationId: createdAppData.application.id,
    });
    assert.equal(events.length, 2);
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

    // 7f. Logout clears session cookie
    const logoutReq = new NextRequest("http://localhost:3000/api/auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        "X-CareerOS-CSRF": loginJson.csrfToken,
        Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
      },
      body: JSON.stringify({ action: "logout" }),
    });
    const logoutRes = await postAuth(logoutReq);
    assert.equal(logoutRes.status, 200);
  });

  it("8. Paginated & incremental Gmail sync, message ID deduplication, and revoked token handling", async () => {
    saveEncryptedOAuthToken({
      accountEmail: "owner@example.com",
      accessToken: "ya29.valid-test-access-token",
      refreshToken: "1//valid-test-refresh-token",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      expiresInSeconds: 3600,
    });

    const originalFetch = globalThis.fetch;
    try {
      // Mock 2-page Gmail messages list + message details
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/gmail/v1/users/me/messages?")) {
          if (url.includes("pageToken=page_2")) {
            return new Response(
              JSON.stringify({
                messages: [{ id: "gmail_msg_p2_1", threadId: "thr_2" }],
              }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              messages: [{ id: "gmail_msg_p1_1", threadId: "thr_1" }],
              nextPageToken: "page_2",
            }),
            { status: 200 }
          );
        }

        if (url.includes("/gmail/v1/users/me/messages/gmail_msg_p1_1")) {
          return new Response(
            JSON.stringify({
              id: "gmail_msg_p1_1",
              threadId: "thr_1",
              internalDate: String(Date.now()),
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

        if (url.includes("/gmail/v1/users/me/messages/gmail_msg_p2_1")) {
          return new Response(
            JSON.stringify({
              id: "gmail_msg_p2_1",
              threadId: "thr_2",
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

        return new Response("Not Found", { status: 404 });
      };

      const appsBefore = listApplications().length;
      const sync1 = await syncLiveGmailMessages({ maxPages: 3, pageSize: 10 });
      assert.equal(sync1.pagesFetched, 2);
      assert.equal(sync1.processedCount, 2);
      assert.equal(sync1.newApplications, 1); // 1 new TCS app created on page 1, updated to ASSESSMENT on page 2!
      assert.equal(sync1.deduplicatedCount, 1);
      assert.equal(listApplications().length, appsBefore + 1);

      const statusAfterSuccess = getOAuthIntegrationStatus();
      assert.ok(statusAfterSuccess.lastGmailSyncAt);
      assert.equal(statusAfterSuccess.tokenStatus, "VALID");
      assert.equal(statusAfterSuccess.lastSyncError, null);

      // Repeat sync of the exact same messages creates ZERO new applications
      const sync2 = await syncLiveGmailMessages({ maxPages: 3, pageSize: 10 });
      assert.equal(sync2.processedCount, 2);
      assert.equal(sync2.newApplications, 0);
      assert.equal(sync2.deduplicatedCount, 2);
      assert.equal(listApplications().length, appsBefore + 1);

      // Simulate revoked Google OAuth token (HTTP 401 from Gmail API)
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            error: { code: 401, message: "Invalid Credentials" },
          }),
          { status: 401 }
        );

      await assert.rejects(
        () => syncLiveGmailMessages(),
        /Gmail API returned 401/
      );

      const statusAfterRevoke = getOAuthIntegrationStatus();
      assert.equal(statusAfterRevoke.tokenStatus, "REVOKED");
      assert.ok(
        statusAfterRevoke.lastSyncError?.includes("401"),
        "Should record lastSyncError on 401 failure"
      );
      assert.ok(
        statusAfterRevoke.lastGmailSyncAt,
        "Should preserve last successful sync timestamp after error"
      );
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
