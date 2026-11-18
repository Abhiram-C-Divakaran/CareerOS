import type {
  ApplicationPortal,
  ApplicationStatus,
  EventSource,
  PriorityLevel,
} from "./types.ts";

export const ALLOWED_STATUSES: readonly ApplicationStatus[] = [
  "APPLIED",
  "UNDER_REVIEW",
  "ASSESSMENT",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
] as const;

export const ALLOWED_PORTALS: readonly ApplicationPortal[] = [
  "LinkedIn",
  "Amazon Careers",
  "TCS NextStep",
  "Wipro Careers",
  "Infosys",
  "Accenture",
  "Indeed",
  "Naukri",
  "Company Website",
  "Other",
] as const;

export const ALLOWED_PRIORITIES: readonly PriorityLevel[] = [
  "HIGH",
  "MEDIUM",
  "LOW",
] as const;

export const ALLOWED_WORK_MODES = ["Remote", "Hybrid", "On-site"] as const;

export const ALLOWED_INTERVIEW_STATUSES = [
  "UPCOMING",
  "COMPLETED",
  "CANCELLED",
] as const;

export const ALLOWED_EVENT_SOURCES: readonly EventSource[] = [
  "MANUAL",
  "GMAIL_SYNC",
  "CALENDAR_SYNC",
  "CHROME_EXTENSION",
  "SYSTEM",
  "PORTAL_UPDATE",
] as const;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function validateApplicationStatus(
  status: unknown,
  fieldName = "status"
): ApplicationStatus {
  if (
    typeof status !== "string" ||
    !ALLOWED_STATUSES.includes(status as ApplicationStatus)
  ) {
    throw new ValidationError(
      `Invalid ${fieldName}. Allowed values: ${ALLOWED_STATUSES.join(", ")}`
    );
  }
  return status as ApplicationStatus;
}

export function validateApplicationPortal(
  portal: unknown,
  fieldName = "portal"
): ApplicationPortal {
  if (
    typeof portal !== "string" ||
    !ALLOWED_PORTALS.includes(portal as ApplicationPortal)
  ) {
    throw new ValidationError(
      `Invalid ${fieldName}. Allowed values: ${ALLOWED_PORTALS.join(", ")}`
    );
  }
  return portal as ApplicationPortal;
}

export function validatePriority(priority: unknown): PriorityLevel {
  if (
    typeof priority !== "string" ||
    !ALLOWED_PRIORITIES.includes(priority as PriorityLevel)
  ) {
    throw new ValidationError(
      `Invalid priority. Allowed values: ${ALLOWED_PRIORITIES.join(", ")}`
    );
  }
  return priority as PriorityLevel;
}

export function validateWorkMode(
  workMode: unknown
): "Remote" | "Hybrid" | "On-site" | null {
  if (workMode === null || workMode === undefined || workMode === "") {
    return null;
  }
  if (
    typeof workMode !== "string" ||
    !ALLOWED_WORK_MODES.includes(workMode as "Remote" | "Hybrid" | "On-site")
  ) {
    throw new ValidationError(
      `Invalid workMode. Allowed values: ${ALLOWED_WORK_MODES.join(", ")}`
    );
  }
  return workMode as "Remote" | "Hybrid" | "On-site";
}

export function validateInterviewStatus(
  status: unknown
): "UPCOMING" | "COMPLETED" | "CANCELLED" {
  if (
    typeof status !== "string" ||
    !ALLOWED_INTERVIEW_STATUSES.includes(
      status as "UPCOMING" | "COMPLETED" | "CANCELLED"
    )
  ) {
    throw new ValidationError(
      `Invalid interview status. Allowed values: ${ALLOWED_INTERVIEW_STATUSES.join(", ")}`
    );
  }
  return status as "UPCOMING" | "COMPLETED" | "CANCELLED";
}

export function validateRequiredString(
  val: unknown,
  fieldName: string,
  maxLength = 200
): string {
  if (typeof val !== "string" || val.trim().length === 0) {
    throw new ValidationError(`${fieldName} is required and must be a non-empty string.`);
  }
  const trimmed = val.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(
      `${fieldName} exceeds maximum length of ${maxLength} characters.`
    );
  }
  return trimmed;
}

export function validateOptionalString(
  val: unknown,
  fieldName: string,
  maxLength = 2000
): string | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val !== "string") {
    throw new ValidationError(`${fieldName} must be a string.`);
  }
  const trimmed = val.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw new ValidationError(
      `${fieldName} exceeds maximum length of ${maxLength} characters.`
    );
  }
  return trimmed;
}

/**
 * Validates that a URL is strictly http: or https: to prevent javascript:/data: XSS injection
 */
export function validateSafeHttpUrl(
  val: unknown,
  fieldName = "url"
): string | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val !== "string") {
    throw new ValidationError(`${fieldName} must be a string.`);
  }
  const trimmed = val.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2048) {
    throw new ValidationError(`${fieldName} is too long.`);
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ValidationError(
        `${fieldName} must use http:// or https:// protocol.`
      );
    }
    return parsed.toString();
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`${fieldName} must be a valid HTTP/HTTPS URL.`);
  }
}

export function validateOptionalIsoDate(
  val: unknown,
  fieldName: string
): string | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val !== "string") {
    throw new ValidationError(`${fieldName} must be an ISO date string.`);
  }
  const ms = Date.parse(val.trim());
  if (Number.isNaN(ms)) {
    throw new ValidationError(`${fieldName} is not a valid date.`);
  }
  return new Date(ms).toISOString();
}
