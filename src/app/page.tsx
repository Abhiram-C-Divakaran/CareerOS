"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Award,
  Bell,
  Briefcase,
  Calendar,
  CheckCircle2,
  Chrome,
  Clock,
  Download,
  ExternalLink,
  Filter,
  Globe,
  History,
  KeyRound,
  LayoutDashboard,
  Lock,
  Mail,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Unlock,
  Video,
  XCircle,
} from "lucide-react";
import type {
  ApplicationPortal,
  ApplicationStatus,
  ApplicationTimelineEvent,
  DailyBriefing,
  InterviewEvent,
  JobApplication,
  OAuthIntegrationStatus,
  SyncedEmailRecord,
} from "@/lib/types";

interface DashboardPayload {
  applications: JobApplication[];
  interviews: InterviewEvent[];
  timeline: ApplicationTimelineEvent[];
  syncedEmails: SyncedEmailRecord[];
  briefing: DailyBriefing;
  oauthStatus: OAuthIntegrationStatus;
  stats: {
    totalApplications: number;
    activeApplications: number;
    offersCount: number;
    rejectionsCount: number;
    upcomingInterviewsCount: number;
    todaysEventsCount: number;
    pendingAssessmentsCount: number;
    pendingFollowUpsCount: number;
    portalCounts: Record<string, number>;
    statusCounts: Record<string, number>;
  };
}

type ActiveTab =
  | "dashboard"
  | "applications"
  | "interviews"
  | "sync"
  | "history"
  | "assistant";

const STATUS_OPTIONS: ApplicationStatus[] = [
  "APPLIED",
  "UNDER_REVIEW",
  "ASSESSMENT",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
];

const PORTAL_OPTIONS: ApplicationPortal[] = [
  "Amazon Careers",
  "TCS NextStep",
  "Wipro Careers",
  "Infosys",
  "Accenture",
  "LinkedIn",
  "Indeed",
  "Naukri",
  "Company Website",
  "Other",
];

const STATUS_STYLES: Record<ApplicationStatus, string> = {
  APPLIED: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  UNDER_REVIEW: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  ASSESSMENT: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  INTERVIEW: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  OFFER: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  REJECTED: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  WITHDRAWN: "bg-slate-500/15 text-slate-300 border-slate-500/30",
};

const EMAIL_PRESETS = [
  {
    label: "Amazon SDE-1 Assessment Invite",
    messageId: "msg_preset_amzn_oa_2026",
    sender: "Amazon University Talent <university-recruiting@amazon.com>",
    subject:
      "Online Assessment Invitation: Software Development Engineer I at Amazon (Job ID: AMZN-REQ-2849103)",
    bodyText:
      "Hello Abhiram, Thank you for applying to Amazon for Software Development Engineer I (Requisition ID: AMZN-REQ-2849103). Please complete your HackerRank Online Assessment before deadline: 2026-11-22.",
  },
  {
    label: "TCS NextStep Interview Invite",
    messageId: "msg_preset_tcs_int_2026",
    sender: "TCS NextStep Team <nextstep.support@tcs.com>",
    subject:
      "Interview Invitation: TCS Digital Specialist Engineer (Ref: CT20264891203)",
    bodyText:
      "Dear Candidate (CT20264891203), You have cleared the TCS NQT Prime assessment for Digital Specialist Engineer at Tata Consultancy Services (TCS). Your technical interview is scheduled for 2026-11-21. Join link: https://teams.microsoft.com/l/meetup-join/tcs-prime-interview",
  },
  {
    label: "Infosys Specialist Programmer Offer",
    messageId: "msg_preset_infy_offer_2026",
    sender: "Infosys Talent Acquisition <talent.acquisition@infosys.com>",
    subject:
      "Congratulations! Offer of Employment for Specialist Programmer at Infosys (Application ID: INFY-SP-551920)",
    bodyText:
      "Dear Abhiram, Congratulations! We are pleased to extend an offer of employment for the role of Specialist Programmer (SP L2) at Infosys (Application ID: INFY-SP-551920).",
  },
  {
    label: "New LinkedIn Application (Microsoft)",
    messageId: "msg_preset_msft_apply_2026",
    sender: "LinkedIn Jobs <jobs-noreply@linkedin.com>",
    subject:
      "Abhiram, your application was sent to Microsoft for Software Engineer II",
    bodyText:
      "Your application was sent to Microsoft for the role of Software Engineer II (Application ID: MSFT-AZ-774190). Good luck!",
  },
];

export default function CareerOSApp() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>("dashboard");
  const [toast, setToast] = useState<{
    text: string;
    type: "success" | "info" | "error";
  } | null>(null);

  // Filters
  const [appPortalFilter, setAppPortalFilter] = useState<string>("ALL");
  const [appStatusFilter, setAppStatusFilter] = useState<string>("ALL");
  const [appSearch, setAppSearch] = useState<string>("");

  const [historySourceFilter, setHistorySourceFilter] = useState<string>("ALL");
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>("ALL");
  const [historySearch, setHistorySearch] = useState<string>("");

  // Modals & Drawers
  const [showNewAppModal, setShowNewAppModal] = useState(false);
  const [showNewInterviewModal, setShowNewInterviewModal] = useState(false);
  const [showSecurityModal, setShowSecurityModal] = useState(false);

  // New Application / Extension Capture Form
  const [newAppForm, setNewAppForm] = useState({
    company: "",
    role: "",
    portal: "Amazon Careers" as ApplicationPortal,
    portalApplicationId: "",
    sourceUrl: "",
    location: "Bengaluru, KA",
    workMode: "Hybrid" as "Remote" | "Hybrid" | "On-site",
    compensation: "",
    status: "APPLIED" as ApplicationStatus,
    assessmentDeadline: "",
    recruiterEmail: "",
    notes: "",
    priority: "HIGH" as "HIGH" | "MEDIUM" | "LOW",
    source: "MANUAL" as "MANUAL" | "CHROME_EXTENSION",
  });

  // New Interview Form
  const [newInterviewForm, setNewInterviewForm] = useState({
    company: "",
    role: "",
    roundName: "Technical Round 1: Coding & Architecture",
    scheduledStart: new Date(Date.now() + 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 16),
    meetingLink: "https://meet.google.com/abc-defg-hij",
    organizerEmail: "",
    prepNotes: "",
    reminderMinutesBefore: 30,
  });

  // Email Ingestion Workbench State
  const [rawEmailForm, setRawEmailForm] = useState({
    messageId: EMAIL_PRESETS[0].messageId,
    sender: EMAIL_PRESETS[0].sender,
    subject: EMAIL_PRESETS[0].subject,
    bodyText: EMAIL_PRESETS[0].bodyText,
  });
  const [periodicSyncEnabled, setPeriodicSyncEnabled] = useState(true);
  const [notificationPermission, setNotificationPermission] =
    useState<string>("default");

  // Single-User Auth State
  const [isSessionAuthenticated, setIsSessionAuthenticated] = useState(false);
  const [passwordConfigured, setPasswordConfigured] = useState(true);
  const [csrfToken, setCsrfToken] = useState<string>("");
  const [generatedExtensionToken, setGeneratedExtensionToken] = useState<
    string | null
  >(null);
  const [isLocked, setIsLocked] = useState(true);
  const [masterPasswordInput, setMasterPasswordInput] = useState("");

  const showNotificationBanner = useCallback(
    (text: string, type: "success" | "info" | "error" = "success") => {
      setToast({ text, type });
      setTimeout(() => {
        setToast((prev) => (prev?.text === text ? null : prev));
      }, 4500);
    },
    []
  );

  const getMutationHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (csrfToken) {
      headers["X-CareerOS-CSRF"] = csrfToken;
    }
    return headers;
  }, [csrfToken]);

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (res.status === 401) {
        setIsSessionAuthenticated(false);
        setIsLocked(true);
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error("Failed to load CareerOS dashboard");
      const json = (await res.json()) as DashboardPayload;
      setData(json);
    } catch (err) {
      showNotificationBanner(
        err instanceof Error ? err.message : "Failed to fetch dashboard",
        "error"
      );
    } finally {
      setLoading(false);
    }
  }, [showNotificationBanner]);

  useEffect(() => {
    fetch("/api/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setPasswordConfigured(Boolean(d.passwordConfigured));
        if (d.authenticated) {
          setIsSessionAuthenticated(true);
          setCsrfToken(d.csrfToken || "");
          setIsLocked(false);
          fetchDashboard();
        } else {
          setIsSessionAuthenticated(false);
          setIsLocked(true);
          setLoading(false);
        }
      })
      .catch(() => {
        setLoading(false);
      });

    if (typeof window !== "undefined") {
      if ("Notification" in window) {
        setNotificationPermission(Notification.permission);
      }
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      }
    }
  }, [fetchDashboard]);

  // Periodic background synchronization polling
  useEffect(() => {
    if (!periodicSyncEnabled || !isSessionAuthenticated || isLocked) return;
    const timer = setInterval(() => {
      fetchDashboard();
    }, 60_000);
    return () => clearInterval(timer);
  }, [periodicSyncEnabled, isSessionAuthenticated, isLocked, fetchDashboard]);

  const filteredApplications = useMemo(() => {
    if (!data) return [];
    return data.applications.filter((app) => {
      if (appPortalFilter !== "ALL" && app.portal !== appPortalFilter) {
        return false;
      }
      if (appStatusFilter !== "ALL" && app.status !== appStatusFilter) {
        return false;
      }
      if (appSearch.trim()) {
        const q = appSearch.toLowerCase();
        const match =
          app.company.toLowerCase().includes(q) ||
          app.role.toLowerCase().includes(q) ||
          app.portal.toLowerCase().includes(q) ||
          (app.portalApplicationId || "").toLowerCase().includes(q) ||
          (app.location || "").toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [data, appPortalFilter, appStatusFilter, appSearch]);

  const filteredTimeline = useMemo(() => {
    if (!data) return [];
    return data.timeline.filter((ev) => {
      if (historySourceFilter !== "ALL" && ev.source !== historySourceFilter) {
        return false;
      }
      if (
        historyStatusFilter !== "ALL" &&
        ev.newStatus !== historyStatusFilter
      ) {
        return false;
      }
      if (historySearch.trim()) {
        const q = historySearch.toLowerCase();
        const match =
          ev.company.toLowerCase().includes(q) ||
          ev.role.toLowerCase().includes(q) ||
          ev.title.toLowerCase().includes(q) ||
          ev.description.toLowerCase().includes(q) ||
          (ev.externalReferenceId || "").toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [data, historySourceFilter, historyStatusFilter, historySearch]);

  async function handleStatusChange(
    applicationId: string,
    newStatus: ApplicationStatus
  ) {
    try {
      const res = await fetch("/api/applications", {
        method: "PATCH",
        headers: getMutationHeaders(),
        body: JSON.stringify({
          id: applicationId,
          status: newStatus,
          source: "MANUAL",
          reasonNote: `Updated status to ${newStatus} from CareerOS dashboard.`,
        }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      await fetchDashboard();
      showNotificationBanner(
        `Status updated to ${newStatus} & recorded in immutable timeline.`
      );
    } catch (err) {
      showNotificationBanner(
        err instanceof Error ? err.message : "Update failed",
        "error"
      );
    }
  }

  async function handleCreateApplication(e: React.FormEvent) {
    e.preventDefault();
    try {
      const endpoint =
        newAppForm.source === "CHROME_EXTENSION"
          ? "/api/extension/capture"
          : "/api/applications";

      const res = await fetch(endpoint, {
        method: "POST",
        headers: getMutationHeaders(),
        body: JSON.stringify({
          ...newAppForm,
          portalApplicationId: newAppForm.portalApplicationId || null,
          sourceUrl: newAppForm.sourceUrl || null,
          assessmentDeadline: newAppForm.assessmentDeadline
            ? new Date(newAppForm.assessmentDeadline).toISOString()
            : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save application");

      setShowNewAppModal(false);
      setNewAppForm({
        company: "",
        role: "",
        portal: "Amazon Careers",
        portalApplicationId: "",
        sourceUrl: "",
        location: "Bengaluru, KA",
        workMode: "Hybrid",
        compensation: "",
        status: "APPLIED",
        assessmentDeadline: "",
        recruiterEmail: "",
        notes: "",
        priority: "HIGH",
        source: "MANUAL",
      });
      await fetchDashboard();
      showNotificationBanner(
        json.deduplicated
          ? `Deduplicated & updated existing application for ${json.application.company}!`
          : `Saved ${json.application.company} (${json.application.portal}) to CareerOS!`
      );
    } catch (err) {
      showNotificationBanner(
        err instanceof Error ? err.message : "Failed to save",
        "error"
      );
    }
  }

  async function handleCreateInterview(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch("/api/interviews", {
        method: "POST",
        headers: getMutationHeaders(),
        body: JSON.stringify({
          ...newInterviewForm,
          scheduledStart: new Date(
            newInterviewForm.scheduledStart
          ).toISOString(),
          source: "CALENDAR_SYNC",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to schedule interview");
      setShowNewInterviewModal(false);
      await fetchDashboard();
      showNotificationBanner(
        `Interview scheduled for ${newInterviewForm.company} and synced to timeline!`
      );
    } catch (err) {
      showNotificationBanner(
        err instanceof Error ? err.message : "Failed to schedule interview",
        "error"
      );
    }
  }

  async function handleIngestRawEmail(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch("/api/integrations/google", {
        method: "POST",
        headers: getMutationHeaders(),
        body: JSON.stringify({
          action: "ingest_raw_email",
          rawEmail: rawEmailForm,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to parse email");
      await fetchDashboard();
      const r = json.result;
      if (r.deduplicatedMessage) {
        showNotificationBanner(
          `Duplicate Gmail Message ID (${rawEmailForm.messageId}) skipped — zero duplicate records created!`,
          "info"
        );
      } else if (r.deduplicatedApplication) {
        showNotificationBanner(
          `Matched existing ${r.record.detectedCompany} application & advanced status to ${r.record.mappedStatus}!`
        );
      } else {
        showNotificationBanner(
          `Created new ${r.record.detectedCompany} application (${r.record.mappedStatus}) from email!`
        );
      }
    } catch (err) {
      showNotificationBanner(
        err instanceof Error ? err.message : "Email sync error",
        "error"
      );
    }
  }

  async function handleSampleBatchSync() {
    try {
      const res = await fetch("/api/integrations/google", {
        method: "POST",
        headers: getMutationHeaders(),
        body: JSON.stringify({ action: "simulate_sync" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Batch sync failed");
      await fetchDashboard();
      showNotificationBanner(
        `Synced ${json.processedCount} sample emails (${json.deduplicatedMessages} duplicate messages skipped, ${json.deduplicatedApplications} linked to existing apps).`
      );
    } catch (err) {
      showNotificationBanner(
        err instanceof Error ? err.message : "Sync failed",
        "error"
      );
    }
  }

  async function handleLiveGoogleSync(action: "sync_gmail" | "sync_calendar") {
    try {
      const res = await fetch("/api/integrations/google", {
        method: "POST",
        headers: getMutationHeaders(),
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Google API sync error");
      await fetchDashboard();
      showNotificationBanner(
        action === "sync_gmail"
          ? `Gmail API sync complete (${json.processedCount} messages processed across ${json.pagesFetched || 1} page(s)).`
          : `Google Calendar sync complete (${json.interviewsSynced} interviews imported).`
      );
    } catch (err) {
      showNotificationBanner(
        err instanceof Error ? err.message : "Google API not connected",
        "info"
      );
    }
  }

  async function handleConnectGoogleOAuth() {
    try {
      const res = await fetch("/api/integrations/google", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not initiate OAuth");
      if (json.oauthUrlInfo?.configured && json.oauthUrlInfo?.url) {
        window.location.href = json.oauthUrlInfo.url;
      } else {
        showNotificationBanner(
          json.oauthUrlInfo?.setupInstructions ||
            "Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local first.",
          "info"
        );
      }
    } catch (err) {
      showNotificationBanner(
        err instanceof Error ? err.message : "OAuth initiation error",
        "error"
      );
    }
  }

  async function handleRegenerateBriefing() {
    try {
      const res = await fetch("/api/briefing", {
        method: "POST",
        headers: getMutationHeaders(),
      });
      if (!res.ok) throw new Error("Failed to regenerate briefing");
      await fetchDashboard();
      showNotificationBanner("Daily AI Career Briefing updated!");
    } catch (err) {
      showNotificationBanner(
        err instanceof Error ? err.message : "Briefing error",
        "error"
      );
    }
  }

  async function handleRequestNotifications() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      showNotificationBanner(
        "Browser notifications are not supported in this environment.",
        "info"
      );
      return;
    }
    const perm = await Notification.requestPermission();
    setNotificationPermission(perm);
    if (perm === "granted") {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "CAREEROS_NOTIFY",
          title: "CareerOS Interview & Deadline Alerts Enabled",
          body: "You will receive alerts for upcoming interviews and coding assessments.",
        });
      } else {
        new Notification("CareerOS Alerts Enabled", {
          body: "Mobile & desktop notifications are active for interviews and assessments.",
        });
      }
      showNotificationBanner("Browser & PWA notifications enabled!");
    } else {
      showNotificationBanner(
        `Notification permission status: ${perm}`,
        "info"
      );
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    try {
      const action = passwordConfigured ? "login" : "setup";
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          password: masterPasswordInput,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Authentication failed");
      setIsSessionAuthenticated(true);
      setPasswordConfigured(true);
      setCsrfToken(json.csrfToken || "");
      setMasterPasswordInput("");
      setIsLocked(false);
      setShowSecurityModal(false);
      setLoading(true);
      await fetchDashboard();
      showNotificationBanner(
        action === "setup"
          ? "Master password configured & single-user session unlocked!"
          : "Single-user HMAC-SHA256 session authenticated & unlocked!"
      );
    } catch (err) {
      showNotificationBanner(
        err instanceof Error ? err.message : "Authentication failed",
        "error"
      );
    }
  }

  async function handleLogoutAndLock() {
    try {
      await fetch("/api/auth", {
        method: "POST",
        headers: getMutationHeaders(),
        body: JSON.stringify({ action: "logout" }),
      });
    } catch {
      // Proceed to lock UI
    }
    setIsSessionAuthenticated(false);
    setCsrfToken("");
    setData(null);
    setIsLocked(true);
  }

  async function handleRotateExtensionToken() {
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: getMutationHeaders(),
        body: JSON.stringify({ action: "rotate_extension_token" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to generate token");
      setGeneratedExtensionToken(json.extensionToken);
      showNotificationBanner(
        "Generated new Chrome Extension API Token! Copy it below."
      );
    } catch (err) {
      showNotificationBanner(
        err instanceof Error ? err.message : "Token generation failed",
        "error"
      );
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#070b14] text-slate-200">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="h-8 w-8 animate-spin text-sky-400" />
          <p className="text-sm font-medium text-slate-400">
            Initializing CareerOS Private Workspace...
          </p>
        </div>
      </div>
    );
  }

  if (isLocked || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#070b14] p-4 text-slate-100">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-2xl">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500/20 text-sky-400">
              <Lock className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold">
                {passwordConfigured
                  ? "CareerOS Vault Locked"
                  : "Initialize CareerOS Master Password"}
              </h1>
              <p className="text-xs text-slate-400">
                Single-User Personal Career Command Center
              </p>
            </div>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
                {passwordConfigured
                  ? "Master Password"
                  : "Create Master Password (min 8 characters)"}
              </label>
              <input
                required
                minLength={8}
                type="password"
                value={masterPasswordInput}
                onChange={(e) => setMasterPasswordInput(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white focus:border-sky-500 focus:outline-none"
                placeholder={
                  passwordConfigured
                    ? "Enter your master password..."
                    : "Choose a strong master password..."
                }
              />
              <p className="mt-1.5 text-xs text-slate-500">
                {passwordConfigured
                  ? "Protected by scrypt + HMAC-SHA256 HTTP-only session cookie."
                  : "Stored locally as a salted scrypt hash in SQLite."}
              </p>
            </div>
            <button
              type="submit"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-500"
            >
              <Unlock className="h-4 w-4" />{" "}
              {passwordConfigured
                ? "Unlock CareerOS"
                : "Set Password & Unlock"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const { stats, briefing, oauthStatus } = data;

  return (
    <div className="flex min-h-screen flex-col bg-[#070b14] pb-20 lg:flex-row lg:pb-0">
      {/* Toast Notification */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 flex max-w-md items-center gap-2.5 rounded-xl border px-4 py-3 text-sm font-medium shadow-2xl backdrop-blur-md transition-all ${
            toast.type === "error"
              ? "border-rose-500/40 bg-rose-950/90 text-rose-200"
              : toast.type === "info"
              ? "border-sky-500/40 bg-sky-950/90 text-sky-200"
              : "border-emerald-500/40 bg-emerald-950/90 text-emerald-200"
          }`}
        >
          <Sparkles className="h-4 w-4 shrink-0" />
          <span>{toast.text}</span>
        </div>
      )}

      {/* Desktop Left Sidebar */}
      <aside className="hidden w-68 shrink-0 flex-col justify-between border-r border-slate-800/80 bg-[#090d16] p-5 lg:flex">
        <div>
          <div className="mb-7 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-blue-700 font-bold text-white shadow-lg shadow-sky-900/30">
                CO
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-base font-bold tracking-tight text-white">
                    CareerOS
                  </span>
                  <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-400">
                    PRIVATE
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  AI Career Command Center
                </p>
              </div>
            </div>
          </div>

          <nav className="space-y-1.5">
            {(
              [
                {
                  id: "dashboard",
                  label: "Private Dashboard",
                  icon: LayoutDashboard,
                  badge: stats.todaysEventsCount,
                },
                {
                  id: "applications",
                  label: "Applications & Portals",
                  icon: Briefcase,
                  badge: stats.totalApplications,
                },
                {
                  id: "interviews",
                  label: "Interviews & Calendar",
                  icon: Calendar,
                  badge: stats.upcomingInterviewsCount,
                },
                {
                  id: "sync",
                  label: "Gmail & OAuth Sync",
                  icon: Mail,
                  badge: data.syncedEmails.length,
                },
                {
                  id: "history",
                  label: "Immutable Timeline",
                  icon: History,
                  badge: data.timeline.length,
                },
                {
                  id: "assistant",
                  label: "Daily AI Assistant",
                  icon: Sparkles,
                },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-sky-500/15 text-sky-300 border border-sky-500/30"
                      : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </span>
                  {"badge" in item && item.badge !== undefined && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        isActive
                          ? "bg-sky-500/30 text-sky-200"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Supported Career Portals Pill List */}
          <div className="mt-8 rounded-xl border border-slate-800/80 bg-slate-900/40 p-3.5">
            <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-400">
              <span>Tracked Portals</span>
              <Globe className="h-3.5 w-3.5 text-sky-400" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[
                "Amazon Careers",
                "TCS NextStep",
                "Wipro Careers",
                "Infosys",
                "Accenture",
                "LinkedIn",
                "Naukri",
                "Indeed",
              ].map((portal) => (
                <button
                  key={portal}
                  onClick={() => {
                    setAppPortalFilter(portal);
                    setActiveTab("applications");
                  }}
                  className="rounded-md border border-slate-800 bg-slate-950/80 px-2 py-1 text-[11px] text-slate-300 hover:border-sky-500/40 hover:text-sky-300"
                >
                  {portal} ({stats.portalCounts[portal] || 0})
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Security & PWA Status Footer */}
        <div className="space-y-2 border-t border-slate-800/80 pt-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              AES-256-GCM Vault
            </span>
            <button
              onClick={() => setShowSecurityModal(true)}
              className="text-sky-400 hover:underline"
            >
              Security
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleLogoutAndLock}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700"
            >
              <Lock className="h-3.5 w-3.5" /> Lock Vault
            </button>
            <button
              onClick={handleRequestNotifications}
              className="flex items-center justify-center gap-1 rounded-lg border border-slate-800 bg-slate-900/80 px-2.5 py-1.5 text-xs text-slate-300 hover:border-sky-500/40"
              title="Enable Mobile / Browser Reminders"
            >
              <Bell className="h-3.5 w-3.5 text-sky-400" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto">
        {/* Top Header Bar */}
        <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 bg-[#070b14]/90 px-4 py-3.5 backdrop-blur-md sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-blue-700 font-bold text-white lg:hidden">
              CO
            </div>
            <div>
              <h1 className="text-base font-bold text-white sm:text-lg">
                {activeTab === "dashboard" && "Private Career Command Center"}
                {activeTab === "applications" &&
                  "Company Career Websites & Applications"}
                {activeTab === "interviews" &&
                  "Upcoming Interviews & Google Calendar"}
                {activeTab === "sync" &&
                  "Automatic Gmail & Google Calendar Sync"}
                {activeTab === "history" &&
                  "Immutable Application History & Audit Log"}
                {activeTab === "assistant" &&
                  "Daily AI Career Assistant & Briefing"}
              </h1>
              <p className="text-xs text-slate-400">
                Single-user encrypted workspace •{" "}
                {periodicSyncEnabled ? "Auto-sync active" : "Manual sync"}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                setNewAppForm((prev) => ({
                  ...prev,
                  source: "CHROME_EXTENSION",
                }));
                setShowNewAppModal(true);
              }}
              className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/20"
            >
              <Chrome className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Capture Portal Job</span>
              <span className="sm:hidden">Clipper</span>
            </button>

            <button
              onClick={() => {
                setNewAppForm((prev) => ({ ...prev, source: "MANUAL" }));
                setShowNewAppModal(true);
              }}
              className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Application</span>
            </button>
          </div>
        </header>

        <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
          {/* TAB 1: PRIVATE DASHBOARD */}
          {activeTab === "dashboard" && (
            <>
              {/* Daily AI Briefing Banner */}
              <section className="rounded-2xl border border-sky-500/30 bg-gradient-to-r from-sky-950/50 via-slate-900/90 to-indigo-950/40 p-5 shadow-lg">
                <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/20 px-2.5 py-0.5 text-xs font-semibold text-sky-300">
                        <Sparkles className="h-3.5 w-3.5" /> Daily AI Briefing (
                        {briefing.briefingDate})
                      </span>
                      <span className="text-xs text-slate-400">
                        Generated by {briefing.generatedBy}
                      </span>
                    </div>
                    <h2 className="text-base font-bold text-white sm:text-lg">
                      {briefing.headline}
                    </h2>
                    <p className="max-w-4xl text-xs leading-relaxed text-slate-300 sm:text-sm">
                      {briefing.executiveSummary}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={handleRegenerateBriefing}
                      className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-500/50"
                    >
                      <RefreshCw className="h-3.5 w-3.5 text-sky-400" />
                      Refresh Briefing
                    </button>
                    <button
                      onClick={() => setActiveTab("assistant")}
                      className="flex items-center gap-1 rounded-lg bg-sky-500/20 px-3 py-1.5 text-xs font-semibold text-sky-300 hover:bg-sky-500/30"
                    >
                      Full AI Report <ArrowUpRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </section>

              {/* Core Statistics Grid */}
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Total Applications</span>
                    <Briefcase className="h-4 w-4 text-sky-400" />
                  </div>
                  <p className="mt-2 text-2xl font-bold text-white">
                    {stats.totalApplications}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Across {Object.keys(stats.portalCounts).length} portals
                  </p>
                </div>

                <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Active Pipeline</span>
                    <Activity className="h-4 w-4 text-indigo-400" />
                  </div>
                  <p className="mt-2 text-2xl font-bold text-indigo-300">
                    {stats.activeApplications}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    In progress / interviewing
                  </p>
                </div>

                <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Upcoming Interviews</span>
                    <Video className="h-4 w-4 text-purple-400" />
                  </div>
                  <p className="mt-2 text-2xl font-bold text-purple-300">
                    {stats.upcomingInterviewsCount}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Calendar & email synced
                  </p>
                </div>

                <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Assessments Due</span>
                    <Clock className="h-4 w-4 text-amber-400" />
                  </div>
                  <p className="mt-2 text-2xl font-bold text-amber-300">
                    {stats.pendingAssessmentsCount}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    {stats.pendingFollowUpsCount} follow-ups ready
                  </p>
                </div>

                <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Offers Received</span>
                    <Award className="h-4 w-4 text-emerald-400" />
                  </div>
                  <p className="mt-2 text-2xl font-bold text-emerald-300">
                    {stats.offersCount}
                  </p>
                  <p className="mt-1 text-[11px] text-emerald-400/80">
                    Accenture ACN-WD-993011
                  </p>
                </div>

                <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-4">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Rejections</span>
                    <XCircle className="h-4 w-4 text-rose-400" />
                  </div>
                  <p className="mt-2 text-2xl font-bold text-rose-300">
                    {stats.rejectionsCount}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Archived in history
                  </p>
                </div>
              </section>

              {/* Today's Events & Upcoming Interviews + Deadlines & Follow-ups */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {/* Upcoming Interviews Card */}
                <section className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-5">
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-white sm:text-base">
                        Today&apos;s Events & Upcoming Interviews
                      </h3>
                      <p className="text-xs text-slate-400">
                        Synced from Google Calendar & interview confirmation emails
                      </p>
                    </div>
                    <button
                      onClick={() => setShowNewInterviewModal(true)}
                      className="rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-xs font-medium text-sky-300 hover:border-sky-500/40"
                    >
                      + Schedule
                    </button>
                  </div>

                  <div className="space-y-3">
                    {data.interviews
                      .filter((i) => i.status === "UPCOMING")
                      .map((intv) => (
                        <div
                          key={intv.id}
                          className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-white">
                                  {intv.company}
                                </span>
                                <span className="rounded-full bg-purple-500/20 px-2 py-0.5 text-[10px] font-semibold text-purple-300">
                                  {intv.source}
                                </span>
                              </div>
                              <p className="text-xs font-medium text-sky-300">
                                {intv.roundName}
                              </p>
                              <p className="mt-0.5 text-xs text-slate-400">
                                Role: {intv.role}
                              </p>
                            </div>
                            {intv.meetingLink && (
                              <a
                                href={intv.meetingLink}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
                              >
                                <Video className="h-3.5 w-3.5" /> Join Meeting
                              </a>
                            )}
                          </div>
                          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-2 text-xs text-slate-400">
                            <span className="flex items-center gap-1 text-amber-300">
                              <Clock className="h-3.5 w-3.5" />
                              {new Date(intv.scheduledStart).toLocaleString()}
                            </span>
                            <span>
                              Reminder: {intv.reminderMinutesBefore}m before
                            </span>
                          </div>
                          {intv.prepNotes && (
                            <p className="mt-2 rounded-lg bg-slate-900/90 p-2 text-xs text-slate-300">
                              <strong className="text-slate-200">Prep:</strong>{" "}
                              {intv.prepNotes}
                            </p>
                          )}
                        </div>
                      ))}
                  </div>
                </section>

                {/* Pending Assessments & Follow-ups Card */}
                <section className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-5">
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-white sm:text-base">
                        Assessment Deadlines & Pending Follow-Ups
                      </h3>
                      <p className="text-xs text-slate-400">
                        Applications requiring immediate action across portals
                      </p>
                    </div>
                    <AlertTriangle className="h-4 w-4 text-amber-400" />
                  </div>

                  <div className="space-y-3">
                    {briefing.attentionApplications.map((item) => (
                      <div
                        key={item.applicationId}
                        className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-white">
                              {item.company}
                            </span>
                            <span className="rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300">
                              {item.portal}
                            </span>
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                                STATUS_STYLES[item.status]
                              }`}
                            >
                              {item.status}
                            </span>
                          </div>
                          <button
                            onClick={() => {
                              setAppSearch(item.company);
                              setActiveTab("applications");
                            }}
                            className="text-xs font-medium text-sky-400 hover:underline"
                          >
                            Inspect →
                          </button>
                        </div>
                        <p className="mt-1 text-xs font-medium text-slate-300">
                          {item.role}
                        </p>
                        <p className="mt-1 text-xs text-amber-300/90">
                          {item.reason}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          Recommendation: {item.suggestedAction}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              {/* Recent Immutable Activity & Portal Statistics */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <section className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-5 lg:col-span-2">
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-white sm:text-base">
                        Recent Immutable Activity Stream
                      </h3>
                      <p className="text-xs text-slate-400">
                        Every status transition recorded with source & timestamp
                      </p>
                    </div>
                    <button
                      onClick={() => setActiveTab("history")}
                      className="text-xs font-medium text-sky-400 hover:underline"
                    >
                      View Full Audit Log ({data.timeline.length}) →
                    </button>
                  </div>

                  <div className="space-y-2.5">
                    {data.timeline.slice(0, 6).map((ev) => (
                      <div
                        key={ev.id}
                        className="flex flex-col justify-between gap-2 rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 sm:flex-row sm:items-center"
                      >
                        <div className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-bold text-white">
                              {ev.company}
                            </span>
                            <span className="text-xs text-slate-400">
                              • {ev.title}
                            </span>
                            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
                              {ev.source}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400">
                            {ev.description}
                          </p>
                        </div>
                        <span className="shrink-0 text-[11px] text-slate-500">
                          {new Date(ev.eventTimestamp).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>

                {/* Application Statistics by Portal & Status */}
                <section className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-5">
                  <h3 className="text-sm font-bold text-white sm:text-base">
                    Portal & Stage Breakdown
                  </h3>
                  <p className="mb-4 text-xs text-slate-400">
                    Distribution across career websites
                  </p>

                  <div className="space-y-3">
                    {Object.entries(stats.portalCounts).map(
                      ([portal, count]) => {
                        const pct = Math.round(
                          (count / Math.max(1, stats.totalApplications)) * 100
                        );
                        return (
                          <div key={portal} className="space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="font-medium text-slate-200">
                                {portal}
                              </span>
                              <span className="text-slate-400">
                                {count} app{count > 1 ? "s" : ""} ({pct}%)
                              </span>
                            </div>
                            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-500"
                                style={{ width: `${Math.max(12, pct)}%` }}
                              />
                            </div>
                          </div>
                        );
                      }
                    )}
                  </div>
                </section>
              </div>
            </>
          )}

          {/* TAB 2: APPLICATIONS & CAREER WEBSITES */}
          {activeTab === "applications" && (
            <section className="space-y-4">
              {/* Filter & Search Bar */}
              <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 md:flex-row md:items-center md:justify-between">
                <div className="relative flex-1">
                  <Search className=" absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    value={appSearch}
                    onChange={(e) => setAppSearch(e.target.value)}
                    placeholder="Search company, role, or Portal Application ID (e.g. AMZN-REQ-2849103, CT20264891203)..."
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2 pr-4 pl-9 text-sm text-white focus:border-sky-500 focus:outline-none"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={appPortalFilter}
                    onChange={(e) => setAppPortalFilter(e.target.value)}
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200"
                  >
                    <option value="ALL">All Career Portals</option>
                    {PORTAL_OPTIONS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>

                  <select
                    value={appStatusFilter}
                    onChange={(e) => setAppStatusFilter(e.target.value)}
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200"
                  >
                    <option value="ALL">All Statuses</option>
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Applications Cards / Table */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {filteredApplications.map((app) => (
                  <div
                    key={app.id}
                    className="flex flex-col justify-between rounded-2xl border border-slate-800/90 bg-slate-900/50 p-5 transition hover:border-slate-700"
                  >
                    <div>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-base font-bold text-white">
                              {app.company}
                            </h3>
                            <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-300">
                              {app.portal}
                            </span>
                            {app.portalApplicationId && (
                              <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-300">
                                ID: {app.portalApplicationId}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-sm font-medium text-slate-200">
                            {app.role}
                          </p>
                        </div>

                        <select
                          aria-label={`Status for ${app.company}`}
                          value={app.status}
                          onChange={(e) =>
                            handleStatusChange(
                              app.id,
                              e.target.value as ApplicationStatus
                            )
                          }
                          className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                            STATUS_STYLES[app.status]
                          } bg-slate-950 focus:outline-none`}
                        >
                          {STATUS_OPTIONS.map((st) => (
                            <option
                              key={st}
                              value={st}
                              className="bg-slate-900 text-white"
                            >
                              {st}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-400">
                        <span>📍 {app.location || "India"}</span>
                        {app.workMode && <span>• {app.workMode}</span>}
                        {app.compensation && (
                          <span className="text-emerald-300">
                            • {app.compensation}
                          </span>
                        )}
                        <span>
                          • Applied:{" "}
                          {new Date(app.appliedDate).toLocaleDateString()}
                        </span>
                      </div>

                      {app.assessmentDeadline && (
                        <div className="mt-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
                          ⏰ Assessment Deadline:{" "}
                          {new Date(app.assessmentDeadline).toLocaleString()}
                        </div>
                      )}

                      {app.notes && (
                        <p className="mt-2.5 text-xs leading-relaxed text-slate-400">
                          {app.notes}
                        </p>
                      )}
                    </div>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-3 text-xs">
                      <span className="text-slate-500">
                        Updated{" "}
                        {new Date(app.lastActivityDate).toLocaleDateString()}
                      </span>
                      <div className="flex items-center gap-3">
                        {app.sourceUrl && (
                          <a
                            href={app.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-sky-400 hover:underline"
                          >
                            Open Portal <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        <button
                          onClick={() => {
                            setHistorySearch(app.company);
                            setActiveTab("history");
                          }}
                          className="text-slate-300 hover:text-white"
                        >
                          View History →
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* TAB 3: INTERVIEWS & GOOGLE CALENDAR */}
          {activeTab === "interviews" && (
            <section className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                <div>
                  <h2 className="text-base font-bold text-white">
                    Interview Schedule & Google Calendar Sync
                  </h2>
                  <p className="text-xs text-slate-400">
                    Automatically identifies interview invitations, saves meeting
                    links, and generates browser/mobile reminders
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleRequestNotifications}
                    className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-medium text-slate-200 hover:border-sky-500/40"
                  >
                    <Bell className="h-3.5 w-3.5 text-sky-400" />
                    {notificationPermission === "granted"
                      ? "Send Test Reminder"
                      : "Enable Reminders"}
                  </button>
                  <button
                    onClick={() => handleLiveGoogleSync("sync_calendar")}
                    className="flex items-center gap-1.5 rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs font-medium text-sky-300 hover:bg-sky-500/20"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Sync Google Calendar
                  </button>
                  <button
                    onClick={() => setShowNewInterviewModal(true)}
                    className="flex items-center gap-1.5 rounded-xl bg-sky-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-sky-500"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add Interview
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {data.interviews.map((intv) => (
                  <div
                    key={intv.id}
                    className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="rounded-full bg-purple-500/20 px-2.5 py-0.5 text-[10px] font-semibold text-purple-300">
                          {intv.status} • {intv.source}
                        </span>
                        <h3 className="mt-1.5 text-base font-bold text-white">
                          {intv.company} — {intv.roundName}
                        </h3>
                        <p className="text-xs text-slate-300">{intv.role}</p>
                      </div>
                      {intv.meetingLink && (
                        <a
                          href={intv.meetingLink}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-500"
                        >
                          <Video className="h-3.5 w-3.5" /> Launch Meeting
                        </a>
                      )}
                    </div>

                    <div className="mt-3 space-y-1 text-xs text-slate-400">
                      <p>
                        <strong className="text-slate-200">Start:</strong>{" "}
                        {new Date(intv.scheduledStart).toLocaleString()}
                      </p>
                      <p>
                        <strong className="text-slate-200">End:</strong>{" "}
                        {new Date(intv.scheduledEnd).toLocaleString()}
                      </p>
                      {intv.meetingLink && (
                        <p className="truncate">
                          <strong className="text-slate-200">
                            Meeting URL:
                          </strong>{" "}
                          <a
                            href={intv.meetingLink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-400 hover:underline"
                          >
                            {intv.meetingLink}
                          </a>
                        </p>
                      )}
                      {intv.organizerEmail && (
                        <p>
                          <strong className="text-slate-200">Organizer:</strong>{" "}
                          {intv.organizerEmail}
                        </p>
                      )}
                    </div>

                    {intv.prepNotes && (
                      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300">
                        <strong className="text-sky-300">
                          Preparation Notes:
                        </strong>{" "}
                        {intv.prepNotes}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* TAB 4: GMAIL & GOOGLE CALENDAR SYNC HUB */}
          {activeTab === "sync" && (
            <div className="space-y-6">
              {/* OAuth Connection & Security Status */}
              <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
                <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-bold text-white">
                        Official Google OAuth 2.0 & Encrypted Token Storage
                      </h2>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
                          oauthStatus.tokenStatus === "VALID"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : oauthStatus.tokenStatus === "REVOKED" ||
                              oauthStatus.tokenStatus === "EXPIRED"
                            ? "bg-rose-500/20 text-rose-300"
                            : "bg-amber-500/20 text-amber-300"
                        }`}
                      >
                        {oauthStatus.connected
                          ? `${oauthStatus.tokenStatus} (${oauthStatus.accountEmail})`
                          : `Status: ${oauthStatus.tokenStatus}`}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      Encryption: {oauthStatus.encryptionAlgorithm} • Scopes:{" "}
                      <code>gmail.readonly</code>,{" "}
                      <code>calendar.events.readonly</code>
                    </p>
                    <div className="flex flex-wrap gap-4 pt-1 text-[11px] text-slate-400">
                      <span>
                        Last Gmail Sync:{" "}
                        <strong className="text-slate-200">
                          {oauthStatus.lastGmailSyncAt
                            ? new Date(
                                oauthStatus.lastGmailSyncAt
                              ).toLocaleString()
                            : "Never"}
                        </strong>
                      </span>
                      <span>
                        Last Calendar Sync:{" "}
                        <strong className="text-slate-200">
                          {oauthStatus.lastCalendarSyncAt
                            ? new Date(
                                oauthStatus.lastCalendarSyncAt
                              ).toLocaleString()
                            : "Never"}
                        </strong>
                      </span>
                    </div>
                    {oauthStatus.lastSyncError && (
                      <p className="pt-1 text-xs text-rose-300">
                        Last Sync Error: {oauthStatus.lastSyncError}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={handleConnectGoogleOAuth}
                      className="flex items-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-500/15 px-3.5 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/25"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" /> Connect Google
                      OAuth
                    </button>
                    <button
                      onClick={handleSampleBatchSync}
                      className="flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25"
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Test Email Parser
                    </button>
                    <button
                      onClick={() => handleLiveGoogleSync("sync_gmail")}
                      className="flex items-center gap-1.5 rounded-xl bg-sky-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-sky-500"
                    >
                      <Mail className="h-3.5 w-3.5" /> Sync Live Gmail API
                    </button>
                  </div>
                </div>
              </section>

              {/* Email Parser & Deduplication Workbench */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
                  <h3 className="text-sm font-bold text-white sm:text-base">
                    Gmail Job Email Extractor & Deduplication Workbench
                  </h3>
                  <p className="mb-3 text-xs text-slate-400">
                    Test automatic detection of confirmations, assessments,
                    interviews, offers, and rejections with strict Message ID &
                    Application ID deduplication.
                  </p>

                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {EMAIL_PRESETS.map((preset) => (
                      <button
                        key={preset.messageId}
                        type="button"
                        onClick={() => setRawEmailForm(preset)}
                        className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-[11px] text-sky-300 hover:border-sky-500/50"
                      >
                        Load: {preset.label}
                      </button>
                    ))}
                  </div>

                  <form onSubmit={handleIngestRawEmail} className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-[11px] uppercase text-slate-400">
                          Gmail Message ID (Deduplication Key)
                        </label>
                        <input
                          type="text"
                          value={rawEmailForm.messageId}
                          onChange={(e) =>
                            setRawEmailForm({
                              ...rawEmailForm,
                              messageId: e.target.value,
                            })
                          }
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] uppercase text-slate-400">
                          Sender Header
                        </label>
                        <input
                          type="text"
                          value={rawEmailForm.sender}
                          onChange={(e) =>
                            setRawEmailForm({
                              ...rawEmailForm,
                              sender: e.target.value,
                            })
                          }
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] uppercase text-slate-400">
                        Email Subject
                      </label>
                      <input
                        type="text"
                        value={rawEmailForm.subject}
                        onChange={(e) =>
                          setRawEmailForm({
                            ...rawEmailForm,
                            subject: e.target.value,
                          })
                        }
                        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] uppercase text-slate-400">
                        Email Body Text
                      </label>
                      <textarea
                        rows={4}
                        value={rawEmailForm.bodyText}
                        onChange={(e) =>
                          setRawEmailForm({
                            ...rawEmailForm,
                            bodyText: e.target.value,
                          })
                        }
                        className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs text-white"
                      />
                    </div>

                    <button
                      type="submit"
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-sky-500"
                    >
                      <Sparkles className="h-4 w-4" /> Parse, Deduplicate & Sync
                      Email to CareerOS
                    </button>
                  </form>
                </section>

                {/* Synced Emails Log */}
                <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
                  <h3 className="text-sm font-bold text-white sm:text-base">
                    Processed & Deduplicated Gmail Messages (
                    {data.syncedEmails.length})
                  </h3>
                  <p className="mb-3 text-xs text-slate-400">
                    Extracted company, role, application ID, classification, and
                    mapped status
                  </p>

                  <div className="max-h-96 space-y-2.5 overflow-y-auto pr-1">
                    {data.syncedEmails.map((em) => (
                      <div
                        key={em.id}
                        className="rounded-xl border border-slate-800 bg-slate-950/80 p-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-bold text-white">
                            {em.detectedCompany} — {em.detectedRole}
                          </span>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                              STATUS_STYLES[em.mappedStatus]
                            }`}
                          >
                            {em.classification} → {em.mappedStatus}
                          </span>
                        </div>
                        <p className="mt-1 font-medium text-slate-300">
                          {em.subject}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                          <span>Portal: {em.detectedPortal}</span>
                          {em.detectedApplicationId && (
                            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-sky-300">
                              ID: {em.detectedApplicationId}
                            </span>
                          )}
                          <span>
                            •{" "}
                            {em.isDuplicate
                              ? "Deduplicated (Linked Existing App)"
                              : "Created New App"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          )}

          {/* TAB 5: IMMUTABLE HISTORICAL RECORDS */}
          {activeTab === "history" && (
            <section className="space-y-4">
              <div className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 lg:flex-row lg:items-center">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-white">
                      Immutable Application Event Ledger
                    </h2>
                    <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                      SQLite Trigger Enforced (Append-Only)
                    </span>
                  </div>
                  <p className="text-xs text-slate-400">
                    Every status change, email sync, calendar invite, and portal
                    capture is permanently recorded.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href="/api/history?export=csv"
                    download
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-medium text-slate-200 hover:border-sky-500/50"
                  >
                    <Download className="h-3.5 w-3.5 text-sky-400" /> Export CSV
                  </a>
                  <a
                    href="/api/history?export=json"
                    download
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-medium text-slate-200 hover:border-sky-500/50"
                  >
                    <Download className="h-3.5 w-3.5 text-indigo-400" /> Export
                    JSON
                  </a>
                </div>
              </div>

              {/* Filter Controls */}
              <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    placeholder="Filter timeline by company, role, description, or reference ID..."
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2 pr-4 pl-9 text-xs text-white"
                  />
                </div>
                <select
                  value={historySourceFilter}
                  onChange={(e) => setHistorySourceFilter(e.target.value)}
                  className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200"
                >
                  <option value="ALL">All Event Sources</option>
                  <option value="GMAIL_SYNC">GMAIL_SYNC</option>
                  <option value="CALENDAR_SYNC">CALENDAR_SYNC</option>
                  <option value="CHROME_EXTENSION">CHROME_EXTENSION</option>
                  <option value="MANUAL">MANUAL</option>
                </select>
                <select
                  value={historyStatusFilter}
                  onChange={(e) => setHistoryStatusFilter(e.target.value)}
                  className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200"
                >
                  <option value="ALL">All Target Statuses</option>
                  {STATUS_OPTIONS.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </div>

              {/* Timeline List */}
              <div className="space-y-3">
                {filteredTimeline.map((ev) => (
                  <div
                    key={ev.id}
                    className="rounded-xl border border-slate-800/90 bg-slate-900/50 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-white">
                          {ev.company}
                        </span>
                        <span className="text-xs text-slate-400">
                          ({ev.role})
                        </span>
                        <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-300">
                          {ev.source}
                        </span>
                        {ev.previousStatus && ev.newStatus && (
                          <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                            {ev.previousStatus} → {ev.newStatus}
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-xs text-slate-400">
                        {new Date(ev.eventTimestamp).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs font-semibold text-slate-200">
                      {ev.title}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {ev.description}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* TAB 6: DAILY AI ASSISTANT */}
          {activeTab === "assistant" && (
            <section className="space-y-6">
              <div className="rounded-2xl border border-sky-500/30 bg-gradient-to-br from-sky-950/40 via-slate-900 to-slate-950 p-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/20 px-3 py-1 text-xs font-semibold text-sky-300">
                      <Sparkles className="h-3.5 w-3.5" /> Scheduled Daily AI
                      Career Briefing
                    </span>
                    <h2 className="mt-2 text-xl font-bold text-white">
                      {briefing.headline}
                    </h2>
                    <p className="mt-2 max-w-4xl text-sm leading-relaxed text-slate-300">
                      {briefing.executiveSummary}
                    </p>
                  </div>
                  <button
                    onClick={handleRegenerateBriefing}
                    className="flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-sky-500"
                  >
                    <RefreshCw className="h-4 w-4" /> Run Daily AI Analysis Now
                  </button>
                </div>

                <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-amber-300">
                      Urgent Assessment Deadlines (
                      {briefing.urgentDeadlines.length})
                    </h3>
                    <div className="mt-3 space-y-2.5">
                      {briefing.urgentDeadlines.map((d, i) => (
                        <div
                          key={i}
                          className="rounded-lg border border-slate-800 bg-slate-900 p-2.5 text-xs"
                        >
                          <p className="font-semibold text-white">{d.title}</p>
                          <p className="mt-0.5 text-slate-400">{d.subtitle}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-purple-300">
                      Upcoming Interviews ({briefing.upcomingInterviews.length})
                    </h3>
                    <div className="mt-3 space-y-2.5">
                      {briefing.upcomingInterviews.map((intv, i) => (
                        <div
                          key={i}
                          className="rounded-lg border border-slate-800 bg-slate-900 p-2.5 text-xs"
                        >
                          <p className="font-semibold text-white">
                            {intv.title}
                          </p>
                          <p className="mt-0.5 text-slate-400">
                            {intv.subtitle}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-sky-300">
                      Recommended Follow-Ups (
                      {briefing.recommendedFollowUps.length})
                    </h3>
                    <div className="mt-3 space-y-2.5">
                      {briefing.recommendedFollowUps.map((f, i) => (
                        <div
                          key={i}
                          className="rounded-lg border border-slate-800 bg-slate-900 p-2.5 text-xs"
                        >
                          <p className="font-semibold text-white">{f.title}</p>
                          <p className="mt-0.5 text-slate-400">{f.subtitle}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </main>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="fixed right-0 bottom-0 left-0 z-40 flex items-center justify-around border-t border-slate-800 bg-[#090d16]/95 px-2 py-2 backdrop-blur-md lg:hidden">
        {(
          [
            { id: "dashboard", label: "Home", icon: LayoutDashboard },
            { id: "applications", label: "Portals", icon: Briefcase },
            { id: "interviews", label: "Calendar", icon: Calendar },
            { id: "sync", label: "Gmail", icon: Mail },
            { id: "history", label: "History", icon: History },
            { id: "assistant", label: "AI Brief", icon: Sparkles },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`flex flex-col items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium ${
                active ? "text-sky-400" : "text-slate-400"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Modal: Add / Capture Job Application */}
      {showNewAppModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-bold text-white">
                {newAppForm.source === "CHROME_EXTENSION"
                  ? "Capture Career Portal Application (Extension Clipper)"
                  : "Record New Job Application"}
              </h3>
              <button
                onClick={() => setShowNewAppModal(false)}
                className="text-xs text-slate-400 hover:text-white"
              >
                Close ✕
              </button>
            </div>

            <form onSubmit={handleCreateApplication} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Company Name *
                  </label>
                  <input
                    required
                    type="text"
                    value={newAppForm.company}
                    onChange={(e) =>
                      setNewAppForm({ ...newAppForm, company: e.target.value })
                    }
                    placeholder="e.g. Amazon, TCS, Wipro, Infosys"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Role / Job Title *
                  </label>
                  <input
                    required
                    type="text"
                    value={newAppForm.role}
                    onChange={(e) =>
                      setNewAppForm({ ...newAppForm, role: e.target.value })
                    }
                    placeholder="e.g. Software Development Engineer I"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Career Portal
                  </label>
                  <select
                    value={newAppForm.portal}
                    onChange={(e) =>
                      setNewAppForm({
                        ...newAppForm,
                        portal: e.target.value as ApplicationPortal,
                      })
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  >
                    {PORTAL_OPTIONS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Portal Application / Requisition ID
                  </label>
                  <input
                    type="text"
                    value={newAppForm.portalApplicationId}
                    onChange={(e) =>
                      setNewAppForm({
                        ...newAppForm,
                        portalApplicationId: e.target.value,
                      })
                    }
                    placeholder="e.g. AMZN-REQ-2849103 or CT2026..."
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Current Status
                  </label>
                  <select
                    value={newAppForm.status}
                    onChange={(e) =>
                      setNewAppForm({
                        ...newAppForm,
                        status: e.target.value as ApplicationStatus,
                      })
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Source URL
                  </label>
                  <input
                    type="url"
                    value={newAppForm.sourceUrl}
                    onChange={(e) =>
                      setNewAppForm({
                        ...newAppForm,
                        sourceUrl: e.target.value,
                      })
                    }
                    placeholder="https://www.amazon.jobs/..."
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs text-slate-400">
                  Notes
                </label>
                <textarea
                  rows={2}
                  value={newAppForm.notes}
                  onChange={(e) =>
                    setNewAppForm({ ...newAppForm, notes: e.target.value })
                  }
                  placeholder="Referral details, assessment notes, compensation..."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2.5 text-xs text-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewAppModal(false)}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500"
                >
                  Save to CareerOS
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Schedule Interview */}
      {showNewInterviewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-bold text-white">
                Schedule Interview & Save Meeting Link
              </h3>
              <button
                onClick={() => setShowNewInterviewModal(false)}
                className="text-xs text-slate-400 hover:text-white"
              >
                Close ✕
              </button>
            </div>
            <form onSubmit={handleCreateInterview} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Company *
                  </label>
                  <input
                    required
                    type="text"
                    value={newInterviewForm.company}
                    onChange={(e) =>
                      setNewInterviewForm({
                        ...newInterviewForm,
                        company: e.target.value,
                      })
                    }
                    placeholder="e.g. Amazon"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Role *
                  </label>
                  <input
                    required
                    type="text"
                    value={newInterviewForm.role}
                    onChange={(e) =>
                      setNewInterviewForm({
                        ...newInterviewForm,
                        role: e.target.value,
                      })
                    }
                    placeholder="e.g. SDE-1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">
                  Interview Round Title *
                </label>
                <input
                  required
                  type="text"
                  value={newInterviewForm.roundName}
                  onChange={(e) =>
                    setNewInterviewForm({
                      ...newInterviewForm,
                      roundName: e.target.value,
                    })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Date & Time *
                  </label>
                  <input
                    required
                    type="datetime-local"
                    value={newInterviewForm.scheduledStart}
                    onChange={(e) =>
                      setNewInterviewForm({
                        ...newInterviewForm,
                        scheduledStart: e.target.value,
                      })
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    Meeting Link (Meet / Teams / Zoom / Chime)
                  </label>
                  <input
                    type="url"
                    value={newInterviewForm.meetingLink}
                    onChange={(e) =>
                      setNewInterviewForm({
                        ...newInterviewForm,
                        meetingLink: e.target.value,
                      })
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewInterviewModal(false)}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500"
                >
                  Save Interview
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Single-User Security & Session Controls */}
      {showSecurityModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <KeyRound className="h-5 w-5 text-sky-400" />
                <h3 className="text-base font-bold text-white">
                  Single-User Security & Session Vault
                </h3>
              </div>
              <button
                onClick={() => setShowSecurityModal(false)}
                className="text-xs text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3 text-xs text-slate-300">
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                <p className="font-semibold text-emerald-300">
                  ✓ Server-Side Credential Handling
                </p>
                <p className="mt-1 text-slate-400">
                  OAuth tokens are encrypted at rest in SQLite using{" "}
                  <code>AES-256-GCM</code> derived via <code>node:crypto</code>{" "}
                  scrypt and are never exposed to frontend client bundles.
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                <p className="font-semibold text-sky-300">
                  Session Status:{" "}
                  {isSessionAuthenticated
                    ? "Signed HTTP-Only Cookie + CSRF Token Active"
                    : "Locked"}
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-2">
                <p className="font-semibold text-white">
                  Chrome Extension API Token
                </p>
                <p className="text-slate-400">
                  Generate a scoped token for the CareerOS Portal Companion
                  extension (stored as SHA-256 hash in SQLite).
                </p>
                <button
                  type="button"
                  onClick={handleRotateExtensionToken}
                  className="w-full rounded-lg border border-sky-500/40 bg-sky-500/15 py-2 font-semibold text-sky-300 hover:bg-sky-500/25"
                >
                  Generate / Rotate Extension API Token
                </button>
                {generatedExtensionToken && (
                  <div className="rounded bg-slate-900 p-2 font-mono text-[11px] break-all text-emerald-300">
                    {generatedExtensionToken}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
