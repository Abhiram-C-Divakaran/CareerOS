import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  ApplicationPortal,
  ApplicationStatus,
  ApplicationTimelineEvent,
  DailyBriefing,
  DailyBriefingItem,
  EventSource,
  InterviewEvent,
  JobApplication,
  OAuthIntegrationStatus,
  PriorityLevel,
  SyncedEmailRecord,
} from "./types.ts";
import { parseJobEmail, type RawEmailInput } from "./email-parser.ts";
import {
  decryptSecret,
  encryptSecret,
  hashApiToken,
  hashPassword,
  registerSessionRevocationChecker,
} from "./security.ts";

// Load Node 24's built-in node:sqlite via process.getBuiltinModule
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as unknown as {
  DatabaseSync: new (filename: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
      get: (...params: unknown[]) => Record<string, unknown> | undefined;
      all: (...params: unknown[]) => Record<string, unknown>[];
    };
    close: () => void;
  };
};

type SqliteDb = InstanceType<typeof DatabaseSync>;

const globalForDb = globalThis as unknown as {
  __careerosDb?: SqliteDb;
  __careerosDbPath?: string;
};

export function getDbPath(): string {
  if (process.env.CAREEROS_DB_PATH) {
    return process.env.CAREEROS_DB_PATH;
  }
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, "careeros.db");
}

export function getDb(): SqliteDb {
  const targetPath = getDbPath();
  if (globalForDb.__careerosDb && globalForDb.__careerosDbPath === targetPath) {
    return globalForDb.__careerosDb;
  }

  const dir = path.dirname(targetPath);
  if (targetPath !== ":memory:" && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(targetPath);
  initializeSchema(db);

  globalForDb.__careerosDb = db;
  globalForDb.__careerosDbPath = targetPath;

  registerSessionRevocationChecker(isSessionRevoked);
  seedInitialDataIfEmpty(db);
  return db;
}

function initializeSchema(db: SqliteDb): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      portal TEXT NOT NULL,
      portal_application_id TEXT,
      source_url TEXT,
      location TEXT,
      work_mode TEXT,
      compensation TEXT,
      status TEXT NOT NULL,
      applied_date TEXT NOT NULL,
      last_activity_date TEXT NOT NULL,
      assessment_deadline TEXT,
      follow_up_date TEXT,
      next_interview_at TEXT,
      recruiter_email TEXT,
      notes TEXT,
      priority TEXT NOT NULL DEFAULT 'MEDIUM',
      is_sample INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_applications_company ON applications(company);
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
    CREATE INDEX IF NOT EXISTS idx_applications_portal_app_id ON applications(portal_application_id);

    CREATE TABLE IF NOT EXISTS application_timeline_events (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      event_type TEXT NOT NULL,
      previous_status TEXT,
      new_status TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      source TEXT NOT NULL,
      external_reference_id TEXT,
      metadata_json TEXT,
      event_timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_timeline_app_id ON application_timeline_events(application_id);
    CREATE INDEX IF NOT EXISTS idx_timeline_timestamp ON application_timeline_events(event_timestamp DESC);

    CREATE TRIGGER IF NOT EXISTS prevent_timeline_update
    BEFORE UPDATE ON application_timeline_events
    BEGIN
      SELECT RAISE(ABORT, 'Timeline events are immutable in CareerOS and cannot be modified');
    END;

    CREATE TRIGGER IF NOT EXISTS prevent_timeline_delete
    BEFORE DELETE ON application_timeline_events
    BEGIN
      SELECT RAISE(ABORT, 'Timeline events are immutable in CareerOS and cannot be deleted');
    END;

    CREATE TABLE IF NOT EXISTS interviews (
      id TEXT PRIMARY KEY,
      application_id TEXT,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      round_name TEXT NOT NULL,
      scheduled_start TEXT NOT NULL,
      scheduled_end TEXT NOT NULL,
      meeting_link TEXT,
      organizer_email TEXT,
      calendar_event_id TEXT UNIQUE,
      prep_notes TEXT,
      reminder_minutes_before INTEGER NOT NULL DEFAULT 30,
      reminder_dismissed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'UPCOMING',
      source TEXT NOT NULL DEFAULT 'MANUAL',
      is_sample INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_interviews_start ON interviews(scheduled_start ASC);

    CREATE TABLE IF NOT EXISTS synced_emails (
      id TEXT PRIMARY KEY,
      gmail_message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      subject TEXT NOT NULL,
      sender TEXT NOT NULL,
      received_at TEXT NOT NULL,
      snippet TEXT NOT NULL,
      detected_company TEXT NOT NULL,
      detected_role TEXT NOT NULL,
      detected_portal TEXT NOT NULL,
      detected_application_id TEXT,
      classification TEXT NOT NULL,
      mapped_status TEXT NOT NULL,
      application_id TEXT,
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      is_sample INTEGER NOT NULL DEFAULT 0,
      processed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_briefings (
      id TEXT PRIMARY KEY,
      briefing_date TEXT NOT NULL,
      headline TEXT NOT NULL,
      executive_summary TEXT NOT NULL,
      urgent_deadlines_json TEXT NOT NULL,
      upcoming_interviews_json TEXT NOT NULL,
      recommended_follow_ups_json TEXT NOT NULL,
      attention_applications_json TEXT NOT NULL,
      metrics_snapshot_json TEXT NOT NULL,
      generated_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider TEXT PRIMARY KEY,
      account_email TEXT,
      encrypted_access_token TEXT NOT NULL,
      encrypted_refresh_token TEXT,
      scopes_json TEXT NOT NULL,
      token_expires_at TEXT,
      token_status TEXT NOT NULL DEFAULT 'VALID',
      last_gmail_sync_at TEXT,
      last_calendar_sync_at TEXT,
      last_sync_error TEXT,
      last_sync_error_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS revoked_sessions (
      jti TEXT PRIMARY KEY,
      revoked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      nonce_hash TEXT PRIMARY KEY,
      session_jti TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Safe migrations for existing databases
  const safeAlter = [
    `ALTER TABLE applications ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE interviews ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE synced_emails ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE oauth_tokens ADD COLUMN token_status TEXT NOT NULL DEFAULT 'VALID'`,
    `ALTER TABLE oauth_tokens ADD COLUMN last_sync_error TEXT`,
    `ALTER TABLE oauth_tokens ADD COLUMN last_sync_error_at TEXT`,
  ];
  for (const stmt of safeAlter) {
    try {
      db.exec(stmt);
    } catch {
      // Column already exists
    }
  }

  // Isolate known legacy sample data rows so they are never confused with real personal applications
  db.exec(`
    UPDATE applications SET is_sample = 1
    WHERE portal_application_id IN (
      'AMZN-REQ-2849103', 'CT20264891203', 'INFY-SP-551920', 'WPR-TURBO-88412',
      'ACN-WD-993011', 'LNKD-STR-44201', 'NKR-FK-77123', 'IND-ATL-11029', 'RZP-FE-90412'
    );
    UPDATE interviews SET is_sample = 1
    WHERE calendar_event_id IN ('cal_amzn_sde1_loop1', 'cal_infy_sp_panel')
       OR application_id IN (SELECT id FROM applications WHERE is_sample = 1);
    UPDATE synced_emails SET is_sample = 1
    WHERE gmail_message_id IN (
      'msg_amzn_001', 'msg_tcs_002', 'msg_acn_003',
      'msg_sim_wipro_interview_2026', 'msg_sim_razorpay_confirm_2026'
    ) OR application_id IN (SELECT id FROM applications WHERE is_sample = 1);
  `);
}

function mapRowToApplication(row: Record<string, unknown>): JobApplication {
  return {
    id: String(row.id),
    company: String(row.company),
    role: String(row.role),
    portal: row.portal as ApplicationPortal,
    portalApplicationId: row.portal_application_id ? String(row.portal_application_id) : null,
    sourceUrl: row.source_url ? String(row.source_url) : null,
    location: row.location ? String(row.location) : null,
    workMode: (row.work_mode as JobApplication["workMode"]) || null,
    compensation: row.compensation ? String(row.compensation) : null,
    status: row.status as ApplicationStatus,
    appliedDate: String(row.applied_date),
    lastActivityDate: String(row.last_activity_date),
    assessmentDeadline: row.assessment_deadline ? String(row.assessment_deadline) : null,
    followUpDate: row.follow_up_date ? String(row.follow_up_date) : null,
    nextInterviewAt: row.next_interview_at ? String(row.next_interview_at) : null,
    recruiterEmail: row.recruiter_email ? String(row.recruiter_email) : null,
    notes: row.notes ? String(row.notes) : null,
    priority: (row.priority as PriorityLevel) || "MEDIUM",
    isSample: Boolean(row.is_sample),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRowToTimelineEvent(row: Record<string, unknown>): ApplicationTimelineEvent {
  return {
    id: String(row.id),
    applicationId: String(row.application_id),
    company: String(row.company),
    role: String(row.role),
    eventType: row.event_type as ApplicationTimelineEvent["eventType"],
    previousStatus: row.previous_status ? (row.previous_status as ApplicationStatus) : null,
    newStatus: row.new_status ? (row.new_status as ApplicationStatus) : null,
    title: String(row.title),
    description: String(row.description),
    source: row.source as EventSource,
    externalReferenceId: row.external_reference_id ? String(row.external_reference_id) : null,
    metadataJson: row.metadata_json ? String(row.metadata_json) : null,
    eventTimestamp: String(row.event_timestamp),
    createdAt: String(row.created_at),
  };
}

function mapRowToInterview(row: Record<string, unknown>): InterviewEvent {
  return {
    id: String(row.id),
    applicationId: row.application_id ? String(row.application_id) : null,
    company: String(row.company),
    role: String(row.role),
    roundName: String(row.round_name),
    scheduledStart: String(row.scheduled_start),
    scheduledEnd: String(row.scheduled_end),
    meetingLink: row.meeting_link ? String(row.meeting_link) : null,
    organizerEmail: row.organizer_email ? String(row.organizer_email) : null,
    calendarEventId: row.calendar_event_id ? String(row.calendar_event_id) : null,
    prepNotes: row.prep_notes ? String(row.prep_notes) : null,
    reminderMinutesBefore: Number(row.reminder_minutes_before ?? 30),
    reminderDismissed: Boolean(row.reminder_dismissed),
    status: row.status as InterviewEvent["status"],
    source: row.source as EventSource,
    createdAt: String(row.created_at),
  };
}

function mapRowToSyncedEmail(row: Record<string, unknown>): SyncedEmailRecord {
  return {
    id: String(row.id),
    gmailMessageId: String(row.gmail_message_id),
    threadId: row.thread_id ? String(row.thread_id) : null,
    subject: String(row.subject),
    sender: String(row.sender),
    receivedAt: String(row.received_at),
    snippet: String(row.snippet),
    detectedCompany: String(row.detected_company),
    detectedRole: String(row.detected_role),
    detectedPortal: row.detected_portal as ApplicationPortal,
    detectedApplicationId: row.detected_application_id
      ? String(row.detected_application_id)
      : null,
    classification: row.classification as SyncedEmailRecord["classification"],
    mappedStatus: row.mapped_status as ApplicationStatus,
    applicationId: row.application_id ? String(row.application_id) : null,
    isDuplicate: Boolean(row.is_duplicate),
    processedAt: String(row.processed_at),
  };
}

export function appendImmutableTimelineEvent(
  db: SqliteDb,
  params: {
    applicationId: string;
    company: string;
    role: string;
    eventType: ApplicationTimelineEvent["eventType"];
    previousStatus?: ApplicationStatus | null;
    newStatus?: ApplicationStatus | null;
    title: string;
    description: string;
    source: EventSource;
    externalReferenceId?: string | null;
    metadata?: Record<string, unknown> | null;
    eventTimestamp?: string;
  }
): ApplicationTimelineEvent {
  const id = `evt_${crypto.randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  const eventTimestamp = params.eventTimestamp || now;
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;

  db.prepare(
    `INSERT INTO application_timeline_events (
      id, application_id, company, role, event_type, previous_status, new_status,
      title, description, source, external_reference_id, metadata_json, event_timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.applicationId,
    params.company,
    params.role,
    params.eventType,
    params.previousStatus ?? null,
    params.newStatus ?? null,
    params.title,
    params.description,
    params.source,
    params.externalReferenceId ?? null,
    metadataJson,
    eventTimestamp,
    now
  );

  return {
    id,
    applicationId: params.applicationId,
    company: params.company,
    role: params.role,
    eventType: params.eventType,
    previousStatus: params.previousStatus ?? null,
    newStatus: params.newStatus ?? null,
    title: params.title,
    description: params.description,
    source: params.source,
    externalReferenceId: params.externalReferenceId ?? null,
    metadataJson,
    eventTimestamp,
    createdAt: now,
  };
}

function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(private|limited|pvt|ltd|inc|corp|corporation|llc|india|technologies|services|tata consultancy services)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function normalizeRole(role: string): string {
  return role
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function shouldIncludeSampleData(explicitFlag?: boolean): boolean {
  if (explicitFlag !== undefined) return explicitFlag;
  return process.env.CAREEROS_ENABLE_SAMPLE_DATA === "true";
}

export function findExistingApplication(
  db: SqliteDb,
  params: {
    portalApplicationId?: string | null;
    company: string;
    role: string;
    includeSample?: boolean;
  }
): JobApplication | null {
  const sampleClause = shouldIncludeSampleData(params.includeSample)
    ? ""
    : " AND is_sample = 0";

  if (params.portalApplicationId) {
    const byPortalId = db
      .prepare(
        `SELECT * FROM applications WHERE UPPER(portal_application_id) = UPPER(?)${sampleClause} LIMIT 1`
      )
      .get(params.portalApplicationId.trim());
    if (byPortalId) return mapRowToApplication(byPortalId);
  }

  const allRows = db
    .prepare(`SELECT * FROM applications WHERE 1=1${sampleClause}`)
    .all();
  const targetComp = normalizeCompany(params.company);
  const targetRole = normalizeRole(params.role);

  for (const row of allRows) {
    const app = mapRowToApplication(row);
    const compMatch =
      normalizeCompany(app.company) === targetComp ||
      (targetComp.length >= 3 && normalizeCompany(app.company).includes(targetComp)) ||
      (normalizeCompany(app.company).length >= 3 && targetComp.includes(normalizeCompany(app.company)));
    const roleMatch =
      normalizeRole(app.role) === targetRole ||
      (targetRole.length >= 5 && normalizeRole(app.role).includes(targetRole)) ||
      (normalizeRole(app.role).length >= 5 && targetRole.includes(normalizeRole(app.role)));

    if (compMatch && roleMatch) {
      return app;
    }
  }

  return null;
}

export function listApplications(filters?: {
  status?: string;
  portal?: string;
  search?: string;
  includeSample?: boolean;
}): JobApplication[] {
  const db = getDb();
  let sql = `SELECT * FROM applications WHERE 1=1`;
  const params: unknown[] = [];

  if (!shouldIncludeSampleData(filters?.includeSample)) {
    sql += ` AND is_sample = 0`;
  }

  if (filters?.status && filters.status !== "ALL") {
    sql += ` AND status = ?`;
    params.push(filters.status);
  }
  if (filters?.portal && filters.portal !== "ALL") {
    sql += ` AND portal = ?`;
    params.push(filters.portal);
  }
  if (filters?.search && filters.search.trim()) {
    const q = `%${filters.search.trim()}%`;
    sql += ` AND (company LIKE ? OR role LIKE ? OR portal_application_id LIKE ? OR portal LIKE ? OR location LIKE ?)`;
    params.push(q, q, q, q, q);
  }

  sql += ` ORDER BY last_activity_date DESC, updated_at DESC`;
  const rows = db.prepare(sql).all(...params);
  return rows.map(mapRowToApplication);
}

export function getApplicationById(id: string): JobApplication | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM applications WHERE id = ?`).get(id);
  return row ? mapRowToApplication(row) : null;
}

export function createOrDeduplicateApplication(input: {
  company: string;
  role: string;
  portal: ApplicationPortal;
  portalApplicationId?: string | null;
  sourceUrl?: string | null;
  location?: string | null;
  workMode?: JobApplication["workMode"];
  compensation?: string | null;
  status?: ApplicationStatus;
  appliedDate?: string;
  assessmentDeadline?: string | null;
  followUpDate?: string | null;
  nextInterviewAt?: string | null;
  recruiterEmail?: string | null;
  notes?: string | null;
  priority?: PriorityLevel;
  source?: EventSource;
  externalReferenceId?: string | null;
  isSample?: boolean;
}): { application: JobApplication; deduplicated: boolean } {
  const db = getDb();
  const existing = findExistingApplication(db, {
    portalApplicationId: input.portalApplicationId,
    company: input.company,
    role: input.role,
    includeSample: input.isSample,
  });

  const now = new Date().toISOString();
  const source = input.source || "MANUAL";

  if (existing) {
    // Update missing metadata or advance status if appropriate
    const newStatus = input.status || existing.status;
    const statusChanged = newStatus !== existing.status;
    const portalAppId = input.portalApplicationId || existing.portalApplicationId;
    const sourceUrl = input.sourceUrl || existing.sourceUrl;
    const assessmentDeadline = input.assessmentDeadline ?? existing.assessmentDeadline;
    const followUpDate = input.followUpDate ?? existing.followUpDate;
    const nextInterviewAt = input.nextInterviewAt ?? existing.nextInterviewAt;

    db.prepare(
      `UPDATE applications SET
        portal_application_id = ?,
        source_url = ?,
        status = ?,
        last_activity_date = ?,
        assessment_deadline = ?,
        follow_up_date = ?,
        next_interview_at = ?,
        updated_at = ?
      WHERE id = ?`
    ).run(
      portalAppId,
      sourceUrl,
      newStatus,
      now,
      assessmentDeadline,
      followUpDate,
      nextInterviewAt,
      now,
      existing.id
    );

    if (statusChanged) {
      appendImmutableTimelineEvent(db, {
        applicationId: existing.id,
        company: existing.company,
        role: existing.role,
        eventType: "STATUS_CHANGED",
        previousStatus: existing.status,
        newStatus,
        title: `Status updated from ${existing.status} to ${newStatus}`,
        description: `Deduplicated update via ${source}${portalAppId ? ` (Ref: ${portalAppId})` : ""}.`,
        source,
        externalReferenceId: input.externalReferenceId ?? portalAppId,
        eventTimestamp: now,
      });
    }

    const updated = getApplicationById(existing.id)!;
    return { application: updated, deduplicated: true };
  }

  const id = `app_${crypto.randomUUID().slice(0, 12)}`;
  const appliedDate = input.appliedDate || now;
  const status: ApplicationStatus = input.status || "APPLIED";
  const defaultFollowUp =
    input.followUpDate !== undefined
      ? input.followUpDate
      : new Date(new Date(appliedDate).getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO applications (
      id, company, role, portal, portal_application_id, source_url, location, work_mode,
      compensation, status, applied_date, last_activity_date, assessment_deadline,
      follow_up_date, next_interview_at, recruiter_email, notes, priority, is_sample, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.company.trim(),
    input.role.trim(),
    input.portal,
    input.portalApplicationId?.trim() || null,
    input.sourceUrl?.trim() || null,
    input.location?.trim() || "Bengaluru, India",
    input.workMode || "Hybrid",
    input.compensation?.trim() || null,
    status,
    appliedDate,
    now,
    input.assessmentDeadline || null,
    defaultFollowUp,
    input.nextInterviewAt || null,
    input.recruiterEmail?.trim() || null,
    input.notes?.trim() || null,
    input.priority || "MEDIUM",
    input.isSample ? 1 : 0,
    now,
    now
  );

  appendImmutableTimelineEvent(db, {
    applicationId: id,
    company: input.company.trim(),
    role: input.role.trim(),
    eventType: source === "CHROME_EXTENSION" ? "PORTAL_CAPTURED" : "APPLICATION_CREATED",
    previousStatus: null,
    newStatus: status,
    title:
      source === "CHROME_EXTENSION"
        ? `Captured from ${input.portal} via CareerOS Extension`
        : `Application recorded for ${input.company.trim()} (${input.portal})`,
    description: `${input.role.trim()} on ${input.portal}${
      input.portalApplicationId ? ` • Portal ID: ${input.portalApplicationId}` : ""
    }${input.sourceUrl ? ` • Source: ${input.sourceUrl}` : ""}`,
    source,
    externalReferenceId: input.externalReferenceId || input.portalApplicationId || null,
    eventTimestamp: appliedDate,
  });

  const created = getApplicationById(id)!;
  return { application: created, deduplicated: false };
}

export function updateApplicationStatusAndFields(
  id: string,
  updates: Partial<{
    status: ApplicationStatus;
    portalApplicationId: string | null;
    sourceUrl: string | null;
    location: string | null;
    workMode: JobApplication["workMode"];
    compensation: string | null;
    assessmentDeadline: string | null;
    followUpDate: string | null;
    nextInterviewAt: string | null;
    recruiterEmail: string | null;
    notes: string | null;
    priority: PriorityLevel;
    source: EventSource;
    reasonNote: string;
  }>
): JobApplication | null {
  const db = getDb();
  const current = getApplicationById(id);
  if (!current) return null;

  const now = new Date().toISOString();
  const nextStatus = updates.status ?? current.status;
  const source = updates.source || "MANUAL";

  db.prepare(
    `UPDATE applications SET
      status = ?,
      portal_application_id = ?,
      source_url = ?,
      location = ?,
      work_mode = ?,
      compensation = ?,
      assessment_deadline = ?,
      follow_up_date = ?,
      next_interview_at = ?,
      recruiter_email = ?,
      notes = ?,
      priority = ?,
      last_activity_date = ?,
      updated_at = ?
    WHERE id = ?`
  ).run(
    nextStatus,
    updates.portalApplicationId !== undefined
      ? updates.portalApplicationId
      : current.portalApplicationId,
    updates.sourceUrl !== undefined ? updates.sourceUrl : current.sourceUrl,
    updates.location !== undefined ? updates.location : current.location,
    updates.workMode !== undefined ? updates.workMode : current.workMode,
    updates.compensation !== undefined ? updates.compensation : current.compensation,
    updates.assessmentDeadline !== undefined
      ? updates.assessmentDeadline
      : current.assessmentDeadline,
    updates.followUpDate !== undefined ? updates.followUpDate : current.followUpDate,
    updates.nextInterviewAt !== undefined ? updates.nextInterviewAt : current.nextInterviewAt,
    updates.recruiterEmail !== undefined ? updates.recruiterEmail : current.recruiterEmail,
    updates.notes !== undefined ? updates.notes : current.notes,
    updates.priority !== undefined ? updates.priority : current.priority,
    now,
    now,
    id
  );

  if (nextStatus !== current.status) {
    const eventTypeMap: Record<ApplicationStatus, ApplicationTimelineEvent["eventType"]> = {
      APPLIED: "STATUS_CHANGED",
      UNDER_REVIEW: "STATUS_CHANGED",
      ASSESSMENT: "ASSESSMENT_ASSIGNED",
      INTERVIEW: "INTERVIEW_SCHEDULED",
      OFFER: "OFFER_RECEIVED",
      REJECTED: "REJECTION_RECEIVED",
      WITHDRAWN: "STATUS_CHANGED",
    };

    appendImmutableTimelineEvent(db, {
      applicationId: id,
      company: current.company,
      role: current.role,
      eventType: eventTypeMap[nextStatus] || "STATUS_CHANGED",
      previousStatus: current.status,
      newStatus: nextStatus,
      title: `Status changed: ${current.status} → ${nextStatus}`,
      description:
        updates.reasonNote ||
        `Application status transitioned from ${current.status} to ${nextStatus} via ${source}.`,
      source,
      eventTimestamp: now,
    });
  } else if (updates.reasonNote) {
    appendImmutableTimelineEvent(db, {
      applicationId: id,
      company: current.company,
      role: current.role,
      eventType: "NOTE_UPDATED",
      previousStatus: current.status,
      newStatus: current.status,
      title: `Application updated (${current.company})`,
      description: updates.reasonNote,
      source,
      eventTimestamp: now,
    });
  }

  return getApplicationById(id);
}

export function deleteApplicationRecord(
  id: string,
  source: EventSource = "MANUAL"
): boolean {
  const db = getDb();
  const current = getApplicationById(id);
  if (!current) return false;

  const now = new Date().toISOString();
  appendImmutableTimelineEvent(db, {
    applicationId: id,
    company: current.company,
    role: current.role,
    eventType: "STATUS_CHANGED",
    previousStatus: current.status,
    newStatus: "WITHDRAWN",
    title: `Application deleted from active tracker (${current.company})`,
    description: `Active record removed via ${source}; immutable historical timeline preserved.`,
    source,
    eventTimestamp: now,
  });

  const res = db.prepare(`DELETE FROM applications WHERE id = ?`).run(id);
  return res.changes > 0;
}

export function listTimelineEvents(filters?: {
  applicationId?: string;
  source?: string;
  status?: string;
  search?: string;
  fromDate?: string;
  toDate?: string;
  includeSample?: boolean;
}): ApplicationTimelineEvent[] {
  const db = getDb();
  let sql = `SELECT * FROM application_timeline_events WHERE 1=1`;
  const params: unknown[] = [];

  if (!shouldIncludeSampleData(filters?.includeSample)) {
    sql += ` AND application_id NOT IN (SELECT id FROM applications WHERE is_sample = 1)`;
  }

  if (filters?.applicationId) {
    sql += ` AND application_id = ?`;
    params.push(filters.applicationId);
  }
  if (filters?.source && filters.source !== "ALL") {
    sql += ` AND source = ?`;
    params.push(filters.source);
  }
  if (filters?.status && filters.status !== "ALL") {
    sql += ` AND new_status = ?`;
    params.push(filters.status);
  }
  if (filters?.search && filters.search.trim()) {
    const q = `%${filters.search.trim()}%`;
    sql += ` AND (company LIKE ? OR role LIKE ? OR title LIKE ? OR description LIKE ? OR external_reference_id LIKE ?)`;
    params.push(q, q, q, q, q);
  }
  if (filters?.fromDate) {
    sql += ` AND event_timestamp >= ?`;
    params.push(filters.fromDate);
  }
  if (filters?.toDate) {
    sql += ` AND event_timestamp <= ?`;
    params.push(filters.toDate);
  }

  sql += ` ORDER BY event_timestamp DESC, created_at DESC`;
  return db.prepare(sql).all(...params).map(mapRowToTimelineEvent);
}

export function listInterviews(
  includeCompleted = true,
  includeSample?: boolean
): InterviewEvent[] {
  const db = getDb();
  const sampleFilter = shouldIncludeSampleData(includeSample)
    ? ""
    : " AND is_sample = 0";
  const sql = includeCompleted
    ? `SELECT * FROM interviews WHERE 1=1${sampleFilter} ORDER BY scheduled_start ASC`
    : `SELECT * FROM interviews WHERE status = 'UPCOMING'${sampleFilter} ORDER BY scheduled_start ASC`;
  return db.prepare(sql).all().map(mapRowToInterview);
}

export function createOrUpdateInterview(input: {
  applicationId?: string | null;
  company: string;
  role: string;
  roundName: string;
  scheduledStart: string;
  scheduledEnd?: string;
  meetingLink?: string | null;
  organizerEmail?: string | null;
  calendarEventId?: string | null;
  prepNotes?: string | null;
  reminderMinutesBefore?: number;
  source?: EventSource;
  isSample?: boolean;
}): { interview: InterviewEvent; created: boolean } {
  const db = getDb();
  const now = new Date().toISOString();
  const source = input.source || "MANUAL";

  if (input.calendarEventId) {
    const existingCal = db
      .prepare(`SELECT * FROM interviews WHERE calendar_event_id = ?`)
      .get(input.calendarEventId);
    if (existingCal) {
      return { interview: mapRowToInterview(existingCal), created: false };
    }
  }

  let matchedAppId = input.applicationId || null;
  if (!matchedAppId) {
    const found = findExistingApplication(db, {
      company: input.company,
      role: input.role,
      includeSample: input.isSample,
    });
    if (found) matchedAppId = found.id;
  }

  const startMs = new Date(input.scheduledStart).getTime();
  const scheduledEnd =
    input.scheduledEnd || new Date(startMs + 60 * 60 * 1000).toISOString();

  const id = `int_${crypto.randomUUID().slice(0, 12)}`;
  db.prepare(
    `INSERT INTO interviews (
      id, application_id, company, role, round_name, scheduled_start, scheduled_end,
      meeting_link, organizer_email, calendar_event_id, prep_notes,
      reminder_minutes_before, reminder_dismissed, status, source, is_sample, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'UPCOMING', ?, ?, ?)`
  ).run(
    id,
    matchedAppId,
    input.company.trim(),
    input.role.trim(),
    input.roundName.trim(),
    input.scheduledStart,
    scheduledEnd,
    input.meetingLink || null,
    input.organizerEmail || null,
    input.calendarEventId || null,
    input.prepNotes || null,
    input.reminderMinutesBefore ?? 30,
    source,
    input.isSample ? 1 : 0,
    now
  );

  if (matchedAppId) {
    const app = getApplicationById(matchedAppId);
    if (app) {
      const nextStatus: ApplicationStatus =
        app.status === "OFFER" ? "OFFER" : "INTERVIEW";
      db.prepare(
        `UPDATE applications SET status = ?, next_interview_at = ?, last_activity_date = ?, updated_at = ? WHERE id = ?`
      ).run(nextStatus, input.scheduledStart, now, now, matchedAppId);

      appendImmutableTimelineEvent(db, {
        applicationId: matchedAppId,
        company: app.company,
        role: app.role,
        eventType: "INTERVIEW_SCHEDULED",
        previousStatus: app.status,
        newStatus: nextStatus,
        title: `Interview scheduled: ${input.roundName}`,
        description: `Scheduled for ${new Date(input.scheduledStart).toLocaleString()}${
          input.meetingLink ? ` • Link: ${input.meetingLink}` : ""
        }`,
        source,
        externalReferenceId: input.calendarEventId || id,
        eventTimestamp: now,
      });
    }
  }

  const row = db.prepare(`SELECT * FROM interviews WHERE id = ?`).get(id)!;
  return { interview: mapRowToInterview(row), created: true };
}

const STATUS_STAGE_RANK: Record<ApplicationStatus, number> = {
  APPLIED: 1,
  UNDER_REVIEW: 2,
  ASSESSMENT: 3,
  INTERVIEW: 4,
  OFFER: 5,
  REJECTED: 5,
  WITHDRAWN: 5,
};

export function hasSyncedEmail(gmailMessageId: string): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT 1 FROM synced_emails WHERE gmail_message_id = ? LIMIT 1`)
    .get(gmailMessageId);
  return Boolean(row);
}

export function ingestEmailMessage(raw: RawEmailInput): {
  record: SyncedEmailRecord | null;
  deduplicatedMessage: boolean;
  deduplicatedApplication: boolean;
  skippedNonJob?: boolean;
  application: JobApplication | null;
} {
  const db = getDb();

  // 1. Check strict Gmail Message ID deduplication
  const existingEmail = db
    .prepare(`SELECT * FROM synced_emails WHERE gmail_message_id = ?`)
    .get(raw.messageId);
  if (existingEmail) {
    const record = mapRowToSyncedEmail(existingEmail);
    const app = record.applicationId ? getApplicationById(record.applicationId) : null;
    return {
      record,
      deduplicatedMessage: true,
      deduplicatedApplication: true,
      application: app,
    };
  }

  const parsed = parseJobEmail(raw);
  if (!parsed.isJobRelated) {
    return {
      record: null,
      deduplicatedMessage: false,
      deduplicatedApplication: false,
      skippedNonJob: true,
      application: null,
    };
  }
  const now = new Date().toISOString();

  // 2. Match or create application with deduplication
  const existingApp = findExistingApplication(db, {
    portalApplicationId: parsed.applicationId,
    company: parsed.company,
    role: parsed.role,
    includeSample: raw.isSample,
  });

  let targetApp: JobApplication;
  let deduplicatedApplication = false;

  if (existingApp) {
    deduplicatedApplication = true;
    const prevStatus = existingApp.status;
    // Prevent older paginated messages from downgrading newer funnel stages
    const incomingTimeMs = Date.parse(raw.receivedAt || now);
    const existingTimeMs = Date.parse(existingApp.lastActivityDate);
    const shouldAdvanceStatus =
      STATUS_STAGE_RANK[parsed.mappedStatus] >= STATUS_STAGE_RANK[prevStatus] ||
      (!Number.isNaN(incomingTimeMs) &&
        !Number.isNaN(existingTimeMs) &&
        incomingTimeMs > existingTimeMs &&
        prevStatus !== "OFFER");

    const nextStatus = shouldAdvanceStatus ? parsed.mappedStatus : prevStatus;
    const latestActivityDate =
      !Number.isNaN(incomingTimeMs) &&
      !Number.isNaN(existingTimeMs) &&
      incomingTimeMs > existingTimeMs
        ? raw.receivedAt || now
        : existingApp.lastActivityDate;
    const nextAssessmentDeadline =
      parsed.classification === "ASSESSMENT" && parsed.extractedDeadline
        ? parsed.extractedDeadline
        : existingApp.assessmentDeadline;
    const nextInterviewAt =
      parsed.classification === "INTERVIEW" && parsed.extractedDeadline
        ? parsed.extractedDeadline
        : existingApp.nextInterviewAt;

    db.prepare(
      `UPDATE applications SET
        status = ?,
        portal_application_id = COALESCE(portal_application_id, ?),
        assessment_deadline = ?,
        next_interview_at = ?,
        last_activity_date = ?,
        updated_at = ?
      WHERE id = ?`
    ).run(
      nextStatus,
      parsed.applicationId,
      nextAssessmentDeadline,
      nextInterviewAt,
      latestActivityDate,
      now,
      existingApp.id
    );

    appendImmutableTimelineEvent(db, {
      applicationId: existingApp.id,
      company: existingApp.company,
      role: existingApp.role,
      eventType:
        parsed.classification === "OFFER"
          ? "OFFER_RECEIVED"
          : parsed.classification === "REJECTION"
          ? "REJECTION_RECEIVED"
          : parsed.classification === "ASSESSMENT"
          ? "ASSESSMENT_ASSIGNED"
          : parsed.classification === "INTERVIEW"
          ? "INTERVIEW_SCHEDULED"
          : "EMAIL_DETECTED",
      previousStatus: prevStatus,
      newStatus: nextStatus,
      title: `Gmail Sync (${parsed.classification}): ${raw.subject}`,
      description: `Detected ${parsed.classification.toLowerCase()} email from ${raw.sender}${
        parsed.applicationId ? ` [ID: ${parsed.applicationId}]` : ""
      }.`,
      source: "GMAIL_SYNC",
      externalReferenceId: raw.messageId,
      eventTimestamp: raw.receivedAt || now,
    });

    targetApp = getApplicationById(existingApp.id)!;
  } else {
    const createdRes = createOrDeduplicateApplication({
      company: parsed.company,
      role: parsed.role,
      portal: parsed.portal,
      portalApplicationId: parsed.applicationId,
      status: parsed.mappedStatus,
      appliedDate: raw.receivedAt || now,
      assessmentDeadline:
        parsed.classification === "ASSESSMENT" ? parsed.extractedDeadline : null,
      nextInterviewAt:
        parsed.classification === "INTERVIEW" ? parsed.extractedDeadline : null,
      recruiterEmail: raw.sender,
      priority:
        parsed.classification === "INTERVIEW" || parsed.classification === "ASSESSMENT"
          ? "HIGH"
          : "MEDIUM",
      source: "GMAIL_SYNC",
      externalReferenceId: raw.messageId,
      isSample: raw.isSample,
    });
    targetApp = createdRes.application;
    deduplicatedApplication = createdRes.deduplicated;
  }

  // If interview email includes a date or meeting link, ensure interview entry exists
  if (parsed.classification === "INTERVIEW") {
    const interviewStart =
      parsed.extractedDeadline ||
      new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    createOrUpdateInterview({
      applicationId: targetApp.id,
      company: targetApp.company,
      role: targetApp.role,
      roundName: raw.subject.slice(0, 80),
      scheduledStart: interviewStart,
      meetingLink: parsed.extractedMeetingLink,
      organizerEmail: raw.sender,
      calendarEventId: `gmail_int_${raw.messageId}`,
      source: "GMAIL_SYNC",
      isSample: raw.isSample,
    });
  }

  const emailRecordId = `em_${crypto.randomUUID().slice(0, 12)}`;
  db.prepare(
    `INSERT INTO synced_emails (
      id, gmail_message_id, thread_id, subject, sender, received_at, snippet,
      detected_company, detected_role, detected_portal, detected_application_id,
      classification, mapped_status, application_id, is_duplicate, is_sample, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    emailRecordId,
    raw.messageId,
    raw.threadId || null,
    raw.subject,
    raw.sender,
    raw.receivedAt || now,
    raw.bodyText.slice(0, 220),
    parsed.company,
    parsed.role,
    parsed.portal,
    parsed.applicationId,
    parsed.classification,
    parsed.mappedStatus,
    targetApp.id,
    deduplicatedApplication ? 1 : 0,
    raw.isSample ? 1 : 0,
    now
  );

  const savedRow = db
    .prepare(`SELECT * FROM synced_emails WHERE id = ?`)
    .get(emailRecordId)!;

  return {
    record: mapRowToSyncedEmail(savedRow),
    deduplicatedMessage: false,
    deduplicatedApplication,
    application: targetApp,
  };
}

export function listSyncedEmails(includeSample?: boolean): SyncedEmailRecord[] {
  const db = getDb();
  const sampleFilter = shouldIncludeSampleData(includeSample)
    ? ""
    : " WHERE is_sample = 0";
  return db
    .prepare(
      `SELECT * FROM synced_emails${sampleFilter} ORDER BY received_at DESC LIMIT 100`
    )
    .all()
    .map(mapRowToSyncedEmail);
}

export function saveEncryptedOAuthToken(params: {
  accountEmail: string;
  accessToken: string;
  refreshToken?: string | null;
  scopes: string[];
  expiresInSeconds?: number;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  const encryptedAccess = encryptSecret(params.accessToken);
  const encryptedRefresh = params.refreshToken
    ? encryptSecret(params.refreshToken)
    : null;
  const expiresAt = params.expiresInSeconds
    ? new Date(Date.now() + params.expiresInSeconds * 1000).toISOString()
    : null;

  db.prepare(
    `INSERT INTO oauth_tokens (
      provider, account_email, encrypted_access_token, encrypted_refresh_token,
      scopes_json, token_expires_at, token_status, last_sync_error, last_sync_error_at, updated_at
    ) VALUES ('google', ?, ?, ?, ?, ?, 'VALID', NULL, NULL, ?)
    ON CONFLICT(provider) DO UPDATE SET
      account_email = excluded.account_email,
      encrypted_access_token = excluded.encrypted_access_token,
      encrypted_refresh_token = COALESCE(excluded.encrypted_refresh_token, oauth_tokens.encrypted_refresh_token),
      scopes_json = excluded.scopes_json,
      token_expires_at = excluded.token_expires_at,
      token_status = 'VALID',
      last_sync_error = NULL,
      last_sync_error_at = NULL,
      updated_at = excluded.updated_at`
  ).run(
    params.accountEmail,
    encryptedAccess,
    encryptedRefresh,
    JSON.stringify(params.scopes),
    expiresAt,
    now
  );
}

export function getDecryptedGoogleTokens(): {
  accountEmail: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  tokenStatus: "VALID" | "EXPIRED" | "REVOKED" | "DISCONNECTED";
  lastGmailSyncAt: string | null;
  lastCalendarSyncAt: string | null;
} | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM oauth_tokens WHERE provider = 'google'`)
    .get();
  if (!row) return null;

  try {
    return {
      accountEmail: row.account_email ? String(row.account_email) : null,
      accessToken: decryptSecret(String(row.encrypted_access_token)),
      refreshToken: row.encrypted_refresh_token
        ? decryptSecret(String(row.encrypted_refresh_token))
        : null,
      tokenExpiresAt: row.token_expires_at ? String(row.token_expires_at) : null,
      tokenStatus:
        (row.token_status as "VALID" | "EXPIRED" | "REVOKED") || "VALID",
      lastGmailSyncAt: row.last_gmail_sync_at
        ? String(row.last_gmail_sync_at)
        : null,
      lastCalendarSyncAt: row.last_calendar_sync_at
        ? String(row.last_calendar_sync_at)
        : null,
    };
  } catch {
    recordOAuthSyncError(
      "Stored Google OAuth token could not be decrypted (key changed or corrupted). Please reconnect your Google account.",
      "REVOKED"
    );
    throw new Error(
      "Stored Google OAuth token is invalid or corrupted. Please reconnect your Google account."
    );
  }
}

export function getOAuthIntegrationStatus(): OAuthIntegrationStatus {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM oauth_tokens WHERE provider = 'google'`)
    .get();

  const hasClientCredentials = Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );

  if (!row) {
    return {
      provider: "google",
      connected: false,
      tokenStatus: "DISCONNECTED",
      accountEmail: null,
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
      ],
      hasClientCredentials,
      lastGmailSyncAt: null,
      lastCalendarSyncAt: null,
      lastSyncError: null,
      lastSyncErrorAt: null,
      tokenExpiresAt: null,
      encryptionAlgorithm:
        "AES-256-GCM (node:crypto scrypt + 96-bit IV + 128-bit AuthTag)",
    };
  }

  const rawStatus =
    (row.token_status as OAuthIntegrationStatus["tokenStatus"]) || "VALID";
  const isExpired =
    rawStatus === "VALID" &&
    row.token_expires_at &&
    new Date(String(row.token_expires_at)).getTime() <= Date.now() &&
    !row.encrypted_refresh_token;

  const effectiveStatus: OAuthIntegrationStatus["tokenStatus"] = isExpired
    ? "EXPIRED"
    : rawStatus;

  return {
    provider: "google",
    connected: effectiveStatus === "VALID" || effectiveStatus === "EXPIRED",
    tokenStatus: effectiveStatus,
    accountEmail: row.account_email ? String(row.account_email) : null,
    scopes: JSON.parse(String(row.scopes_json || "[]")),
    hasClientCredentials,
    lastGmailSyncAt: row.last_gmail_sync_at
      ? String(row.last_gmail_sync_at)
      : null,
    lastCalendarSyncAt: row.last_calendar_sync_at
      ? String(row.last_calendar_sync_at)
      : null,
    lastSyncError: row.last_sync_error ? String(row.last_sync_error) : null,
    lastSyncErrorAt: row.last_sync_error_at
      ? String(row.last_sync_error_at)
      : null,
    tokenExpiresAt: row.token_expires_at ? String(row.token_expires_at) : null,
    encryptionAlgorithm:
      "AES-256-GCM (node:crypto scrypt + 96-bit IV + 128-bit AuthTag)",
  };
}

export function recordSyncTimestamp(channel: "gmail" | "calendar"): void {
  const db = getDb();
  const now = new Date().toISOString();
  const col =
    channel === "gmail" ? "last_gmail_sync_at" : "last_calendar_sync_at";
  db.prepare(
    `UPDATE oauth_tokens SET ${col} = ?, last_sync_error = NULL, last_sync_error_at = NULL, updated_at = ? WHERE provider = 'google'`
  ).run(now, now);
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(`last_${channel}_sync`, now, now);
}

export function recordOAuthSyncError(
  errorMessage: string,
  newTokenStatus?: "EXPIRED" | "REVOKED"
): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (newTokenStatus) {
    db.prepare(
      `UPDATE oauth_tokens SET token_status = ?, last_sync_error = ?, last_sync_error_at = ?, updated_at = ? WHERE provider = 'google'`
    ).run(newTokenStatus, errorMessage.slice(0, 500), now, now);
  } else {
    db.prepare(
      `UPDATE oauth_tokens SET last_sync_error = ?, last_sync_error_at = ?, updated_at = ? WHERE provider = 'google'`
    ).run(errorMessage.slice(0, 500), now, now);
  }
}

export function getMasterPasswordHash(): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT value FROM system_settings WHERE key = 'master_password_hash'`
    )
    .get();
  return row ? String(row.value) : null;
}

export function setMasterPasswordHash(rawPassword: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const hashed = hashPassword(rawPassword);
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('master_password_hash', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(hashed, now);
}

export function getExtensionTokenHash(): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT value FROM system_settings WHERE key = 'extension_api_token_hash'`
    )
    .get();
  return row ? String(row.value) : null;
}

export function rotateExtensionApiToken(): string {
  const db = getDb();
  const now = new Date().toISOString();
  const rawToken = `cos_ext_${crypto.randomBytes(24).toString("hex")}`;
  const tokenHash = hashApiToken(rawToken);
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('extension_api_token_hash', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(tokenHash, now);
  return rawToken;
}

export function revokeSessionJti(jti: string, expSeconds: number): void {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const expIso = new Date(expSeconds * 1000).toISOString();
  db.prepare(`DELETE FROM revoked_sessions WHERE expires_at <= ?`).run(nowIso);
  db.prepare(
    `INSERT OR REPLACE INTO revoked_sessions (jti, revoked_at, expires_at) VALUES (?, ?, ?)`
  ).run(jti, nowIso, expIso);
}

export function isSessionRevoked(jti: string): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT 1 FROM revoked_sessions WHERE jti = ? LIMIT 1`)
    .get(jti);
  return Boolean(row);
}

export function storeOAuthStateNonce(
  nonce: string,
  sessionJti: string,
  expiresAt: string
): void {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const nonceHash = hashApiToken(nonce);
  db.prepare(`DELETE FROM oauth_states WHERE expires_at <= ?`).run(nowIso);
  db.prepare(
    `INSERT OR REPLACE INTO oauth_states (nonce_hash, session_jti, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).run(nonceHash, sessionJti, expiresAt, nowIso);
}

/**
 * Atomically consumes a single-use OAuth state nonce bound to sessionJti.
 * Returns true ONLY on the first valid consumption before expiry.
 */
export function consumeOAuthStateNonce(
  nonce: string,
  sessionJti: string
): boolean {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const nonceHash = hashApiToken(nonce);
  db.prepare(`DELETE FROM oauth_states WHERE expires_at <= ?`).run(nowIso);
  const res = db
    .prepare(
      `DELETE FROM oauth_states WHERE nonce_hash = ? AND session_jti = ? AND expires_at > ?`
    )
    .run(nonceHash, sessionJti, nowIso);
  return res.changes > 0;
}

export function generateDailyBriefing(): DailyBriefing {
  const db = getDb();
  const apps = listApplications();
  const interviews = listInterviews(false);
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  const activeApps = apps.filter(
    (a) => !["REJECTED", "WITHDRAWN"].includes(a.status)
  );
  const offers = apps.filter((a) => a.status === "OFFER");
  const rejections = apps.filter((a) => a.status === "REJECTED");

  const urgentDeadlines: DailyBriefingItem[] = [];
  const recommendedFollowUps: DailyBriefingItem[] = [];
  const attentionApplications: DailyBriefing["attentionApplications"] = [];

  for (const app of activeApps) {
    if (app.assessmentDeadline) {
      const dueMs = new Date(app.assessmentDeadline).getTime() - now.getTime();
      const hoursLeft = Math.round(dueMs / (1000 * 60 * 60));
      if (hoursLeft <= 120 && hoursLeft >= -24) {
        urgentDeadlines.push({
          title: `${app.company} — ${app.role} Assessment`,
          subtitle: `Portal: ${app.portal}${
            app.portalApplicationId ? ` (${app.portalApplicationId})` : ""
          } • Due in ${Math.max(1, hoursLeft)}h`,
          urgency: hoursLeft <= 36 ? "CRITICAL" : "HIGH",
          actionLabel: "Complete Assessment",
          applicationId: app.id,
          dueAt: app.assessmentDeadline,
        });

        attentionApplications.push({
          applicationId: app.id,
          company: app.company,
          role: app.role,
          portal: app.portal,
          status: app.status,
          reason: `Coding/Online Assessment deadline approaching (${new Date(
            app.assessmentDeadline
          ).toLocaleDateString()})`,
          suggestedAction: `Complete ${app.portal} assessment before deadline and verify submission ID ${
            app.portalApplicationId || ""
          }.`,
        });
      }
    }

    if (
      (app.status === "APPLIED" || app.status === "UNDER_REVIEW") &&
      app.followUpDate
    ) {
      const followMs = new Date(app.followUpDate).getTime() - now.getTime();
      if (followMs <= 2 * 24 * 60 * 60 * 1000) {
        recommendedFollowUps.push({
          title: `Follow up with ${app.company} (${app.role})`,
          subtitle: `Status: ${app.status} on ${app.portal} • Last update ${new Date(
            app.lastActivityDate
          ).toLocaleDateString()}`,
          urgency: "NORMAL",
          actionLabel: "Send Recruiter Follow-Up",
          applicationId: app.id,
          dueAt: app.followUpDate,
        });

        attentionApplications.push({
          applicationId: app.id,
          company: app.company,
          role: app.role,
          portal: app.portal,
          status: app.status,
          reason: `No portal movement since ${new Date(
            app.lastActivityDate
          ).toLocaleDateString()}`,
          suggestedAction: `Check ${app.portal} candidate dashboard or send a concise status inquiry to ${
            app.recruiterEmail || "recruiting team"
          }.`,
        });
      }
    }
  }

  const upcomingInterviews: DailyBriefingItem[] = interviews
    .filter((i) => new Date(i.scheduledStart).getTime() >= now.getTime() - 3600000)
    .slice(0, 5)
    .map((intv) => {
      const diffHours = Math.round(
        (new Date(intv.scheduledStart).getTime() - now.getTime()) / (1000 * 60 * 60)
      );
      return {
        title: `${intv.company} — ${intv.roundName}`,
        subtitle: `${intv.role} • ${new Date(intv.scheduledStart).toLocaleString()}`,
        urgency: diffHours <= 24 ? "CRITICAL" : "HIGH",
        actionLabel: intv.meetingLink ? "Join / Prep" : "Review Notes",
        applicationId: intv.applicationId || undefined,
        dueAt: intv.scheduledStart,
      };
    });

  for (const intv of interviews.slice(0, 3)) {
    if (intv.applicationId) {
      const app = getApplicationById(intv.applicationId);
      if (
        app &&
        !attentionApplications.some((a) => a.applicationId === app.id)
      ) {
        attentionApplications.push({
          applicationId: app.id,
          company: app.company,
          role: app.role,
          portal: app.portal,
          status: app.status,
          reason: `Upcoming interview: ${intv.roundName}`,
          suggestedAction: `Review system design & behavioral stories; verify meeting link (${
            intv.meetingLink || "on calendar"
          }).`,
        });
      }
    }
  }

  const metricsSnapshot = {
    totalApplications: apps.length,
    activeApplications: activeApps.length,
    interviewsUpcoming: upcomingInterviews.length,
    pendingAssessments: urgentDeadlines.length,
    pendingFollowUps: recommendedFollowUps.length,
    offersCount: offers.length,
    rejectionsCount: rejections.length,
  };

  const headline =
    upcomingInterviews.length > 0 || urgentDeadlines.length > 0
      ? `Focus on ${upcomingInterviews.length} upcoming interview(s) and ${urgentDeadlines.length} assessment deadline(s) today.`
      : `You have ${activeApps.length} active applications across ${
          new Set(activeApps.map((a) => a.portal)).size
        } career portals.`;

  const executiveSummary = `CareerOS Daily AI Briefing (${todayStr}): Tracking ${apps.length} total applications (${activeApps.length} active, ${offers.length} offer(s), ${rejections.length} archived). Prioritize ${
    urgentDeadlines[0]?.title || "pending technical assessments"
  } and prepare for ${
    upcomingInterviews[0]?.title || "scheduled technical interviews"
  }. ${recommendedFollowUps.length} application(s) are ready for a proactive follow-up check.`;

  const id = `brf_${crypto.randomUUID().slice(0, 12)}`;
  const createdAt = now.toISOString();

  db.prepare(
    `INSERT INTO daily_briefings (
      id, briefing_date, headline, executive_summary, urgent_deadlines_json,
      upcoming_interviews_json, recommended_follow_ups_json, attention_applications_json,
      metrics_snapshot_json, generated_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    todayStr,
    headline,
    executiveSummary,
    JSON.stringify(urgentDeadlines),
    JSON.stringify(upcomingInterviews),
    JSON.stringify(recommendedFollowUps),
    JSON.stringify(attentionApplications),
    JSON.stringify(metricsSnapshot),
    process.env.GEMINI_API_KEY ? "CareerOS AI + Gemini Engine" : "CareerOS AI Decision Engine",
    createdAt
  );

  return {
    id,
    briefingDate: todayStr,
    headline,
    executiveSummary,
    urgentDeadlines,
    upcomingInterviews,
    recommendedFollowUps,
    attentionApplications,
    metricsSnapshot,
    generatedBy: process.env.GEMINI_API_KEY
      ? "CareerOS AI + Gemini Engine"
      : "CareerOS AI Decision Engine",
    createdAt,
  };
}

export function getLatestDailyBriefing(): DailyBriefing {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM daily_briefings ORDER BY created_at DESC LIMIT 1`)
    .get();
  if (!row) {
    return generateDailyBriefing();
  }
  return {
    id: String(row.id),
    briefingDate: String(row.briefing_date),
    headline: String(row.headline),
    executiveSummary: String(row.executive_summary),
    urgentDeadlines: JSON.parse(String(row.urgent_deadlines_json)),
    upcomingInterviews: JSON.parse(String(row.upcoming_interviews_json)),
    recommendedFollowUps: JSON.parse(String(row.recommended_follow_ups_json)),
    attentionApplications: JSON.parse(String(row.attention_applications_json)),
    metricsSnapshot: JSON.parse(String(row.metrics_snapshot_json)),
    generatedBy: String(row.generated_by),
    createdAt: String(row.created_at),
  };
}

function seedInitialDataIfEmpty(db: SqliteDb): void {
  if (process.env.CAREEROS_ENABLE_SAMPLE_DATA !== "true") {
    return;
  }
  const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM applications`).get();
  const count = Number(countRow?.cnt ?? 0);
  if (count > 0) return;

  const now = Date.now();
  const hoursFromNow = (h: number) => new Date(now + h * 3600 * 1000).toISOString();
  const daysAgo = (d: number) => new Date(now - d * 86400 * 1000).toISOString();

  // 1. Amazon Careers — INTERVIEW today
  const amazon = createOrDeduplicateApplication({
    company: "Amazon",
    role: "Software Development Engineer I (SDE-1)",
    portal: "Amazon Careers",
    portalApplicationId: "AMZN-REQ-2849103",
    sourceUrl: "https://www.amazon.jobs/en/jobs/2849103/software-development-engineer-i",
    location: "Bengaluru, KA",
    workMode: "Hybrid",
    compensation: "₹28.5 LPA",
    status: "APPLIED",
    appliedDate: daysAgo(12),
    recruiterEmail: "apac-ind-tech-recruiting@amazon.com",
    notes: "Cleared OA1 & OA2 with 2/2 optimal solutions. Loop Round 1 focuses on Low-Level Design + Leadership Principles (Ownership, Dive Deep).",
    priority: "HIGH",
    source: "CHROME_EXTENSION",
  }).application;

  updateApplicationStatusAndFields(amazon.id, {
    status: "ASSESSMENT",
    source: "GMAIL_SYNC",
    reasonNote: "Amazon SDE-1 Online Assessment invitation received via Gmail.",
  });

  createOrUpdateInterview({
    applicationId: amazon.id,
    company: "Amazon",
    role: "Software Development Engineer I (SDE-1)",
    roundName: "Technical Loop Round 1: Data Structures & Leadership Principles",
    scheduledStart: hoursFromNow(3),
    scheduledEnd: hoursFromNow(4),
    meetingLink: "https://chime.aws/8492014421",
    organizerEmail: "apac-ind-tech-recruiting@amazon.com",
    calendarEventId: "cal_amzn_sde1_loop1",
    prepNotes: "Review LFU Cache, Graph BFS/DFS, and STAR stories for Customer Obsession & Bias for Action.",
    reminderMinutesBefore: 30,
    source: "CALENDAR_SYNC",
  });

  // 2. TCS NextStep — ASSESSMENT due tomorrow
  const tcs = createOrDeduplicateApplication({
    company: "Tata Consultancy Services (TCS)",
    role: "Digital Specialist Engineer (Prime)",
    portal: "TCS NextStep",
    portalApplicationId: "CT20264891203",
    sourceUrl: "https://nextstep.tcs.com/campus/",
    location: "Hyderabad, TS",
    workMode: "On-site",
    compensation: "₹9.0 - ₹11.5 LPA",
    status: "ASSESSMENT",
    appliedDate: daysAgo(9),
    assessmentDeadline: hoursFromNow(22),
    recruiterEmail: "nextstep.support@tcs.com",
    notes: "TCS NQT Prime Advanced Coding section scheduled. Keep CT Reference ID CT20264891203 ready.",
    priority: "HIGH",
    source: "GMAIL_SYNC",
  }).application;

  // 3. Infosys — INTERVIEW tomorrow
  const infosys = createOrDeduplicateApplication({
    company: "Infosys",
    role: "Specialist Programmer (SP L2)",
    portal: "Infosys",
    portalApplicationId: "INFY-SP-551920",
    sourceUrl: "https://careers.infosys.com/jobs/INFY-SP-551920",
    location: "Bengaluru, KA",
    workMode: "Hybrid",
    compensation: "₹16.0 LPA",
    status: "APPLIED",
    appliedDate: daysAgo(15),
    recruiterEmail: "talent.acquisition@infosys.com",
    notes: "Shortlisted through HackWithInfy / Specialist Programmer track.",
    priority: "HIGH",
    source: "CHROME_EXTENSION",
  }).application;

  createOrUpdateInterview({
    applicationId: infosys.id,
    company: "Infosys",
    role: "Specialist Programmer (SP L2)",
    roundName: "Specialist Programmer Technical Panel & System Design",
    scheduledStart: hoursFromNow(26),
    scheduledEnd: hoursFromNow(27),
    meetingLink: "https://teams.microsoft.com/l/meetup-join/infosys-sp-panel-2026",
    organizerEmail: "talent.acquisition@infosys.com",
    calendarEventId: "cal_infy_sp_panel",
    prepNotes: "Dynamic programming, distributed caching, SQL indexing, and microservice resilience.",
    reminderMinutesBefore: 45,
    source: "CALENDAR_SYNC",
  });

  // 4. Wipro Careers — UNDER_REVIEW with pending follow-up
  createOrDeduplicateApplication({
    company: "Wipro",
    role: "Project Engineer (Wipro Turbo)",
    portal: "Wipro Careers",
    portalApplicationId: "WPR-TURBO-88412",
    sourceUrl: "https://careers.wipro.com/opportunities/WPR-TURBO-88412",
    location: "Pune, MH",
    workMode: "Hybrid",
    compensation: "₹6.5 LPA",
    status: "UNDER_REVIEW",
    appliedDate: daysAgo(8),
    followUpDate: hoursFromNow(-4),
    recruiterEmail: "campus.hiring@wipro.com",
    notes: "Voice & coding assessment cleared. Awaiting technical interview slot allocation.",
    priority: "MEDIUM",
    source: "CHROME_EXTENSION",
  });

  // 5. Accenture — OFFER received
  const accenture = createOrDeduplicateApplication({
    company: "Accenture",
    role: "Advanced App Engineering Analyst",
    portal: "Accenture",
    portalApplicationId: "ACN-WD-993011",
    sourceUrl: "https://accenture.wd3.myworkdayjobs.com/en-US/AccentureCareers/job/ACN-WD-993011",
    location: "Bengaluru, KA",
    workMode: "Hybrid",
    compensation: "₹11.2 LPA",
    status: "INTERVIEW",
    appliedDate: daysAgo(21),
    recruiterEmail: "indiacampus@accenture.com",
    notes: "Completed Cognitive, Coding, Communication, and Final HR/Tech interview.",
    priority: "HIGH",
    source: "GMAIL_SYNC",
  }).application;

  updateApplicationStatusAndFields(accenture.id, {
    status: "OFFER",
    source: "GMAIL_SYNC",
    reasonNote: "Received provisional offer letter via Accenture Workday portal (Ref: ACN-WD-993011).",
  });

  // 6. LinkedIn — Stripe Full Stack Engineer (Pending Follow-up)
  createOrDeduplicateApplication({
    company: "Stripe",
    role: "Full Stack Software Engineer",
    portal: "LinkedIn",
    portalApplicationId: "LNKD-STR-44201",
    sourceUrl: "https://www.linkedin.com/jobs/view/3984120941",
    location: "Bengaluru, KA",
    workMode: "Remote",
    compensation: "₹36.0 LPA",
    status: "APPLIED",
    appliedDate: daysAgo(6),
    followUpDate: hoursFromNow(6),
    recruiterEmail: "india-recruiting@stripe.com",
    notes: "Applied via LinkedIn Easy Apply + referral from senior backend engineer.",
    priority: "HIGH",
    source: "GMAIL_SYNC",
  });

  // 7. Naukri — Flipkart SDE-1 Assessment
  createOrDeduplicateApplication({
    company: "Flipkart",
    role: "Software Development Engineer 1 (Backend)",
    portal: "Naukri",
    portalApplicationId: "NKR-FK-77123",
    sourceUrl: "https://www.naukri.com/job-listings-sde-1-flipkart-bengaluru",
    location: "Bengaluru, KA",
    workMode: "Hybrid",
    compensation: "₹32.0 LPA",
    status: "ASSESSMENT",
    appliedDate: daysAgo(4),
    assessmentDeadline: hoursFromNow(46),
    recruiterEmail: "tech-hiring@flipkart.com",
    notes: "Machine coding round link received via Naukri recruiter message.",
    priority: "HIGH",
    source: "GMAIL_SYNC",
  });

  // 8. Indeed — Atlassian Rejected
  const atlassian = createOrDeduplicateApplication({
    company: "Atlassian",
    role: "Associate Software Developer",
    portal: "Indeed",
    portalApplicationId: "IND-ATL-11029",
    sourceUrl: "https://in.indeed.com/viewjob?jk=atl11029",
    location: "Bengaluru, KA",
    workMode: "Remote",
    compensation: "₹34.0 LPA",
    status: "APPLIED",
    appliedDate: daysAgo(19),
    recruiterEmail: "careers@atlassian.com",
    priority: "MEDIUM",
    source: "GMAIL_SYNC",
  }).application;

  updateApplicationStatusAndFields(atlassian.id, {
    status: "REJECTED",
    source: "GMAIL_SYNC",
    reasonNote: "Automated status update email: position filled with other candidates.",
  });

  // Seed initial synced Gmail records
  db.prepare(
    `INSERT INTO synced_emails (
      id, gmail_message_id, thread_id, subject, sender, received_at, snippet,
      detected_company, detected_role, detected_portal, detected_application_id,
      classification, mapped_status, application_id, is_duplicate, processed_at
    ) VALUES
    (?, 'msg_amzn_001', 'thr_amzn_1', 'Interview Invitation: Software Development Engineer I at Amazon (Job ID: AMZN-REQ-2849103)', 'Amazon Recruiting <apac-ind-tech-recruiting@amazon.com>', ?, 'We are pleased to invite you to Technical Loop Round 1 for Software Development Engineer I (AMZN-REQ-2849103). Join via Chime: https://chime.aws/8492014421', 'Amazon', 'Software Development Engineer I (SDE-1)', 'Amazon Careers', 'AMZN-REQ-2849103', 'INTERVIEW', 'INTERVIEW', ?, 0, ?),
    (?, 'msg_tcs_002', 'thr_tcs_1', 'TCS NextStep Assessment Scheduled - Reference ID: CT20264891203', 'TCS NextStep <nextstep.support@tcs.com>', ?, 'Dear Candidate (CT20264891203), your online coding assessment for Digital Specialist Engineer is scheduled. Please complete the assessment before the deadline.', 'Tata Consultancy Services (TCS)', 'Digital Specialist Engineer (Prime)', 'TCS NextStep', 'CT20264891203', 'ASSESSMENT', 'ASSESSMENT', ?, 0, ?),
    (?, 'msg_acn_003', 'thr_acn_1', 'Congratulations! Offer of Employment from Accenture (Ref: ACN-WD-993011)', 'Accenture Campus Hiring <indiacampus@accenture.com>', ?, 'We are pleased to extend an offer of employment for the role of Advanced App Engineering Analyst at Accenture (Application ID: ACN-WD-993011).', 'Accenture', 'Advanced App Engineering Analyst', 'Accenture', 'ACN-WD-993011', 'OFFER', 'OFFER', ?, 0, ?)`
  ).run(
    `em_${crypto.randomUUID().slice(0, 10)}`,
    daysAgo(2),
    amazon.id,
    daysAgo(2),
    `em_${crypto.randomUUID().slice(0, 10)}`,
    daysAgo(1),
    tcs.id,
    daysAgo(1),
    `em_${crypto.randomUUID().slice(0, 10)}`,
    daysAgo(1),
    accenture.id,
    daysAgo(1)
  );

  // Mark all seeded rows as isolated sample data
  db.exec(`
    UPDATE applications SET is_sample = 1;
    UPDATE interviews SET is_sample = 1;
    UPDATE synced_emails SET is_sample = 1;
  `);
}
