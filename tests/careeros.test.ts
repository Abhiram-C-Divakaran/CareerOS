import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Configure isolated temporary SQLite database for tests
const tempDbPath = path.join(
  os.tmpdir(),
  `careeros-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
);
process.env.CAREEROS_DB_PATH = tempDbPath;

import {
  createSessionToken,
  decryptSecret,
  encryptSecret,
  hashPassword,
  verifyPassword,
  verifySessionToken,
} from "../src/lib/security.ts";
import { parseJobEmail } from "../src/lib/email-parser.ts";
import {
  createOrDeduplicateApplication,
  createOrUpdateInterview,
  generateDailyBriefing,
  getDecryptedGoogleTokens,
  getDb,
  ingestEmailMessage,
  listApplications,
  listTimelineEvents,
  saveEncryptedOAuthToken,
  updateApplicationStatusAndFields,
} from "../src/lib/db.ts";

describe("CareerOS Full-Stack Verification Suite", () => {
  before(() => {
    // Ensure fresh DB initialized
    getDb();
  });

  it("1. AES-256-GCM OAuth token encryption & tamper protection", () => {
    const rawToken = "ya29.a0AfH6SMBx-secret-google-oauth-token-2026";
    const encrypted = encryptSecret(rawToken);
    assert.ok(encrypted.startsWith("v1:"));
    assert.ok(!encrypted.includes(rawToken));

    const decrypted = decryptSecret(encrypted);
    assert.equal(decrypted, rawToken);

    // Tamper with ciphertext and verify GCM auth tag rejects it
    const tampered = encrypted.slice(0, -4) + "ffff";
    assert.throws(() => decryptSecret(tampered));
  });

  it("2. Single-user authentication & HMAC-SHA256 session tokens", () => {
    const hashed = hashPassword("my-personal-vault-pass");
    assert.equal(verifyPassword("my-personal-vault-pass", hashed), true);
    assert.equal(verifyPassword("wrong-password", hashed), false);

    const token = createSessionToken(3600);
    const verified = verifySessionToken(token);
    assert.ok(verified);
    assert.equal(verified.sub, "owner");
    assert.equal(verifySessionToken(token + "tamper"), null);
  });

  it("3. Gmail parser extracts company, role, portal, application ID, and status across portals", () => {
    const tcsEmail = parseJobEmail({
      messageId: "test_tcs_1",
      subject:
        "TCS NextStep Assessment Invitation - Reference ID: CT20269988771",
      sender: "TCS NextStep <nextstep.support@tcs.com>",
      receivedAt: new Date().toISOString(),
      bodyText:
        "Dear Candidate (CT20269988771), thank you for applying to Tata Consultancy Services for Digital Specialist Engineer. Please complete your online coding assessment by deadline: 2026-11-25.",
    });

    assert.equal(tcsEmail.portal, "TCS NextStep");
    assert.equal(tcsEmail.applicationId, "CT20269988771");
    assert.equal(tcsEmail.classification, "ASSESSMENT");
    assert.equal(tcsEmail.mappedStatus, "ASSESSMENT");

    const amazonInterview = parseJobEmail({
      messageId: "test_amzn_1",
      subject:
        "Interview Invitation: Software Development Engineer I at Amazon (Job ID: AMZN-REQ-554433)",
      sender: "Amazon Recruiting <recruiting@amazon.com>",
      receivedAt: new Date().toISOString(),
      bodyText:
        "We are pleased to schedule your technical interview for Software Development Engineer I. Join via https://chime.aws/9988776655",
    });

    assert.equal(amazonInterview.portal, "Amazon Careers");
    assert.equal(amazonInterview.applicationId, "AMZN-REQ-554433");
    assert.equal(amazonInterview.classification, "INTERVIEW");
    assert.equal(amazonInterview.mappedStatus, "INTERVIEW");
    assert.equal(
      amazonInterview.extractedMeetingLink,
      "https://chime.aws/9988776655"
    );
  });

  it("4. Immutable timeline records status changes and blocks UPDATE/DELETE via SQLite triggers", () => {
    const created = createOrDeduplicateApplication({
      company: "Wipro",
      role: "Project Engineer Elite",
      portal: "Wipro Careers",
      portalApplicationId: "WPR-ELITE-77001",
      sourceUrl: "https://careers.wipro.com/jobs/WPR-ELITE-77001",
      status: "APPLIED",
      source: "CHROME_EXTENSION",
    });

    assert.equal(created.deduplicated, false);

    const updated = updateApplicationStatusAndFields(created.application.id, {
      status: "INTERVIEW",
      source: "GMAIL_SYNC",
      reasonNote: "Cleared Wipro coding assessment",
    });
    assert.equal(updated?.status, "INTERVIEW");

    const history = listTimelineEvents({
      applicationId: created.application.id,
    });
    assert.ok(history.length >= 2);
    assert.equal(history[0].previousStatus, "APPLIED");
    assert.equal(history[0].newStatus, "INTERVIEW");

    // Verify SQLite trigger blocks modifying or deleting timeline events
    const db = getDb();
    assert.throws(() => {
      db.prepare(
        `UPDATE application_timeline_events SET title = 'Tampered' WHERE id = ?`
      ).run(history[0].id);
    }, /immutable/i);

    assert.throws(() => {
      db.prepare(`DELETE FROM application_timeline_events WHERE id = ?`).run(
        history[0].id
      );
    }, /immutable/i);
  });

  it("5. Gmail ingestion deduplicates repeated message IDs and links to existing applications", () => {
    const beforeCount = listApplications().length;

    const firstIngest = ingestEmailMessage({
      messageId: "msg_dedup_check_001",
      subject:
        "Interview Invitation: Project Engineer Elite at Wipro (Application ID: WPR-ELITE-77001)",
      sender: "Wipro Careers <campus@wipro.com>",
      receivedAt: new Date().toISOString(),
      bodyText:
        "Your technical interview for Project Engineer Elite (Application ID: WPR-ELITE-77001) is confirmed. Join via https://teams.microsoft.com/l/meetup-join/wipro-123",
    });

    assert.equal(firstIngest.deduplicatedMessage, false);
    assert.equal(firstIngest.deduplicatedApplication, true);
    assert.equal(listApplications().length, beforeCount);

    // Ingesting the exact same messageId a second time is strictly deduplicated
    const secondIngest = ingestEmailMessage({
      messageId: "msg_dedup_check_001",
      subject:
        "Interview Invitation: Project Engineer Elite at Wipro (Application ID: WPR-ELITE-77001)",
      sender: "Wipro Careers <campus@wipro.com>",
      receivedAt: new Date().toISOString(),
      bodyText: "Duplicate delivery test",
    });

    assert.equal(secondIngest.deduplicatedMessage, true);
    assert.equal(listApplications().length, beforeCount);
  });

  it("6. Calendar interview workflow & Daily AI Briefing generation", () => {
    const intv = createOrUpdateInterview({
      company: "Infosys",
      role: "Specialist Programmer (SP L2)",
      roundName: "Final Architecture & Coding Round",
      scheduledStart: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
      meetingLink: "https://meet.google.com/inf-sp2-loop",
      calendarEventId: "cal_test_infy_99",
      source: "CALENDAR_SYNC",
    });

    assert.equal(intv.created, true);

    saveEncryptedOAuthToken({
      accountEmail: "abhiram@gmail.com",
      accessToken: "ya29.encrypted-access-token",
      refreshToken: "1//encrypted-refresh-token",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });

    const tokens = getDecryptedGoogleTokens();
    assert.equal(tokens?.accountEmail, "abhiram@gmail.com");
    assert.equal(tokens?.accessToken, "ya29.encrypted-access-token");

    const briefing = generateDailyBriefing();
    assert.ok(briefing.headline.length > 10);
    assert.ok(briefing.metricsSnapshot.totalApplications >= 8);

    // Cleanup temp DB file if possible
    try {
      fs.unlinkSync(tempDbPath);
    } catch {
      // ignore on Windows if WAL handle is open
    }
  });
});
