export type ApplicationStatus =
  | "APPLIED"
  | "UNDER_REVIEW"
  | "ASSESSMENT"
  | "INTERVIEW"
  | "OFFER"
  | "REJECTED"
  | "WITHDRAWN";

export type ApplicationPortal =
  | "LinkedIn"
  | "Amazon Careers"
  | "TCS NextStep"
  | "Wipro Careers"
  | "Infosys"
  | "Accenture"
  | "Indeed"
  | "Naukri"
  | "Company Website"
  | "Other";

export type EventSource =
  | "MANUAL"
  | "GMAIL_SYNC"
  | "CALENDAR_SYNC"
  | "CHROME_EXTENSION"
  | "SYSTEM"
  | "PORTAL_UPDATE";

export type PriorityLevel = "HIGH" | "MEDIUM" | "LOW";

export interface JobApplication {
  id: string;
  company: string;
  role: string;
  portal: ApplicationPortal;
  portalApplicationId: string | null;
  sourceUrl: string | null;
  location: string | null;
  workMode: "Remote" | "Hybrid" | "On-site" | null;
  compensation: string | null;
  status: ApplicationStatus;
  appliedDate: string;
  lastActivityDate: string;
  assessmentDeadline: string | null;
  followUpDate: string | null;
  nextInterviewAt: string | null;
  recruiterEmail: string | null;
  notes: string | null;
  priority: PriorityLevel;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationTimelineEvent {
  id: string;
  applicationId: string;
  company: string;
  role: string;
  eventType:
    | "APPLICATION_CREATED"
    | "STATUS_CHANGED"
    | "EMAIL_DETECTED"
    | "ASSESSMENT_ASSIGNED"
    | "INTERVIEW_SCHEDULED"
    | "OFFER_RECEIVED"
    | "REJECTION_RECEIVED"
    | "FOLLOW_UP_LOGGED"
    | "PORTAL_CAPTURED"
    | "NOTE_UPDATED";
  previousStatus: ApplicationStatus | null;
  newStatus: ApplicationStatus | null;
  title: string;
  description: string;
  source: EventSource;
  externalReferenceId: string | null;
  metadataJson: string | null;
  eventTimestamp: string;
  createdAt: string;
}

export interface InterviewEvent {
  id: string;
  applicationId: string | null;
  company: string;
  role: string;
  roundName: string;
  scheduledStart: string;
  scheduledEnd: string;
  meetingLink: string | null;
  organizerEmail: string | null;
  calendarEventId: string | null;
  prepNotes: string | null;
  reminderMinutesBefore: number;
  reminderDismissed: boolean;
  status: "UPCOMING" | "COMPLETED" | "CANCELLED";
  source: EventSource;
  createdAt: string;
}

export interface SyncedEmailRecord {
  id: string;
  gmailMessageId: string;
  threadId: string | null;
  subject: string;
  sender: string;
  receivedAt: string;
  snippet: string;
  detectedCompany: string;
  detectedRole: string;
  detectedPortal: ApplicationPortal;
  detectedApplicationId: string | null;
  classification:
    | "CONFIRMATION"
    | "ASSESSMENT"
    | "INTERVIEW"
    | "OFFER"
    | "REJECTION"
    | "UPDATE";
  mappedStatus: ApplicationStatus;
  applicationId: string | null;
  isDuplicate: boolean;
  processedAt: string;
}

export interface DailyBriefingItem {
  title: string;
  subtitle: string;
  urgency: "CRITICAL" | "HIGH" | "NORMAL";
  actionLabel: string;
  applicationId?: string;
  dueAt?: string;
}

export interface DailyBriefing {
  id: string;
  briefingDate: string;
  headline: string;
  executiveSummary: string;
  urgentDeadlines: DailyBriefingItem[];
  upcomingInterviews: DailyBriefingItem[];
  recommendedFollowUps: DailyBriefingItem[];
  attentionApplications: {
    applicationId: string;
    company: string;
    role: string;
    portal: ApplicationPortal;
    status: ApplicationStatus;
    reason: string;
    suggestedAction: string;
  }[];
  metricsSnapshot: {
    totalApplications: number;
    activeApplications: number;
    interviewsUpcoming: number;
    pendingAssessments: number;
    pendingFollowUps: number;
    offersCount: number;
    rejectionsCount: number;
  };
  generatedBy: string;
  createdAt: string;
}

export interface OAuthIntegrationStatus {
  provider: "google";
  connected: boolean;
  accountEmail: string | null;
  scopes: string[];
  hasClientCredentials: boolean;
  lastGmailSyncAt: string | null;
  lastCalendarSyncAt: string | null;
  tokenExpiresAt: string | null;
  encryptionAlgorithm: string;
}
