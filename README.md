# CareerOS — Private AI Career Command Center

A single-user, AI-powered career management web application built with **Next.js 15, TypeScript, Tailwind CSS v4, SQLite (`node:sqlite` in WAL mode), and Official Google OAuth 2.0 APIs**.

## Core Features Implemented

1. **Private Dashboard**
   - Today's events, upcoming interviews, and assessment deadlines
   - KPI summary: Total applications, Active pipeline, Upcoming interviews, Pending assessments, Offers, and Rejections
   - Portal breakdown across **Amazon Careers, TCS NextStep, Wipro Careers, Infosys, Accenture, LinkedIn, Indeed, and Naukri**
   - Recent immutable activity stream

2. **Automatic Gmail Integration (`/api/integrations/google`)**
   - Official Google OAuth 2.0 (`gmail.readonly` minimal scope)
   - Detects job application confirmations, online coding assessments, interview invitations, offers, and rejections
   - Extracts Company Name, Job Title, Portal, Application/Requisition ID (`AMZN-REQ-...`, `CT2026...`, `WPR-...`, `INFY-...`, `ACN-WD-...`), deadlines, and meeting links
   - **Strict two-layer deduplication**: deduplicates by Gmail `messageId` and links updates to existing applications by `portalApplicationId` or normalized `company + role`

3. **Google Calendar Integration (`/api/interviews`, `/api/integrations/google`)**
   - Identifies interview invitations from Google Calendar (`calendar.events.readonly`)
   - Saves meeting links (Google Meet, Microsoft Teams, Amazon Chime, Zoom) and times
   - Supports browser and PWA mobile notifications via Service Worker (`public/sw.js`)

4. **Company Career Website Tracking & Chrome Extension (`chrome-extension/`)**
   - Dedicated Manifest V3 Chrome Extension (**CareerOS Portal Companion**) in [`chrome-extension/`](./chrome-extension)
   - Captures visible job metadata, Application IDs, and portal URLs upon user click and sends them to `POST /api/extension/capture`
   - Strictly respects authentication, login screens, and CAPTCHA challenges (pauses and alerts the user if a challenge is present)

5. **Complete Immutable Historical Records (`/api/history`)**
   - Backed by `application_timeline_events` with SQLite `BEFORE UPDATE` and `BEFORE DELETE` triggers that abort any mutation or deletion attempt
   - Records every status transition with previous status, new status, source (`GMAIL_SYNC`, `CALENDAR_SYNC`, `CHROME_EXTENSION`, `MANUAL`), and ISO timestamp
   - Supports filtering, searching, and exporting history as **CSV** (`/api/history?export=csv`) or **JSON** (`/api/history?export=json`)

6. **Daily AI Assistant (`/api/briefing` & `scripts/daily-cron.ts`)**
   - Generates a daily executive career briefing highlighting urgent coding assessments, today's interviews, and applications requiring follow-up
   - Scheduled job runner via `npm run sync:cron`

7. **Mobile & PWA Support**
   - Responsive layout with desktop sidebar and mobile bottom navigation bar
   - Web App Manifest (`/manifest.webmanifest`) and Service Worker (`/sw.js`) for home-screen installation and notifications

## Security Architecture & Hardening

- **Server-Side Session Authentication**: Every private API route (`/api/dashboard`, `/api/applications`, `/api/history`, `/api/interviews`, `/api/briefing`, `/api/integrations/google`, `/api/integrations/google/callback`, `/api/extension/capture`) enforces server-side session verification (`requireAuthenticatedSession`) and returns `HTTP 401 Unauthorized` when unauthenticated without exposing or mutating data.
- **No Hardcoded Passwords or Secrets**: All fallback passwords and static cryptographic secrets have been removed. Master passwords are stored as salted `scrypt` hashes in SQLite (or read from `CAREEROS_MASTER_PASSWORD`), and `AES-256-GCM` / `HMAC-SHA256` keys are read from environment variables or generated via `crypto.randomBytes(32)` into a local gitignored key file (`data/.careeros-secrets.json` with `0600` permissions).
- **CSRF Protection**: State-changing endpoints (`POST`, `PATCH`, `DELETE`) verify both same-origin (`Origin` / `Referer`) and session-bound `X-CareerOS-CSRF` tokens derived via `HMAC-SHA256(session.jti)`.
- **Session-Bound OAuth State**: Google OAuth initiation generates an expiring, `HMAC-SHA256` signed `state` token bound to the active browser session's `jti` and a short-lived `httpOnly` nonce cookie (`careeros_oauth_state`, 10-minute TTL), validated before exchanging any OAuth authorization code.
- **Token-Secured Chrome Extension API**: `/api/extension/capture` rejects wildcard CORS (`*`) and requires a valid `X-CareerOS-Extension-Token` (stored as a `SHA-256` hash in SQLite and verified with `crypto.timingSafeEqual`) or an authenticated session.
- **Sample Data Isolation**: Sample demo data is disabled by default (`CAREEROS_ENABLE_SAMPLE_DATA=false`) and isolated via `is_sample = 1` so personal databases remain strictly free of sample records.

---

## Account Setup for Live Google OAuth (Gmail & Calendar)

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
2. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
   - Enable the **Gmail API** and **Google Calendar API**.
   - Create an **OAuth 2.0 Client ID** (Web application).
   - Add Authorized Redirect URI:
     `http://localhost:3000/api/integrations/google/callback`
   - Paste `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` into `.env.local`.

## Loading the CareerOS Chrome Extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `chrome-extension/` folder inside this repository.
4. Visit any supported career portal (Amazon Careers, TCS NextStep, Wipro, Infosys, Accenture, LinkedIn, Indeed, Naukri) and click the extension icon to capture the application to CareerOS.
