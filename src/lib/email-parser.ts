import type { ApplicationPortal, ApplicationStatus } from "./types.ts";

export interface RawEmailInput {
  messageId: string;
  threadId?: string | null;
  subject: string;
  sender: string;
  receivedAt: string;
  bodyText: string;
  isSample?: boolean;
}

export interface ParsedJobEmail {
  isJobRelated: boolean;
  company: string;
  role: string;
  portal: ApplicationPortal;
  applicationId: string | null;
  classification:
    | "CONFIRMATION"
    | "ASSESSMENT"
    | "INTERVIEW"
    | "OFFER"
    | "REJECTION"
    | "UPDATE";
  mappedStatus: ApplicationStatus;
  extractedDeadline: string | null;
  extractedMeetingLink: string | null;
  confidence: number;
}

const PORTAL_MATCHERS: {
  portal: ApplicationPortal;
  patterns: RegExp[];
  defaultCompany?: string;
}[] = [
  {
    portal: "Amazon Careers",
    patterns: [
      /amazon\.jobs/i,
      /amazon\s+careers/i,
      /amazon\s+university\s+talent/i,
      /hire\.amazon\.com/i,
      /@amazon\.com/i,
    ],
    defaultCompany: "Amazon",
  },
  {
    portal: "TCS NextStep",
    patterns: [
      /nextstep\.tcs\.com/i,
      /tcs\s+nextstep/i,
      /tata\s+consultancy\s+services/i,
      /@tcs\.com/i,
      /\bCT\d{9,12}\b/i,
      /\bDT\d{9,12}\b/i,
    ],
    defaultCompany: "Tata Consultancy Services (TCS)",
  },
  {
    portal: "Wipro Careers",
    patterns: [
      /wipro\.com/i,
      /wipro\s+careers/i,
      /wipro\s+turbo/i,
      /wipro\s+elite/i,
      /synergy\.wipro/i,
      /superset.*wipro/i,
    ],
    defaultCompany: "Wipro",
  },
  {
    portal: "Infosys",
    patterns: [
      /infosys\.com/i,
      /infosys\s+careers/i,
      /hackwithinfy/i,
      /infytq/i,
      /career.*infosys/i,
    ],
    defaultCompany: "Infosys",
  },
  {
    portal: "Accenture",
    patterns: [
      /accenture\.com/i,
      /accenture\s+careers/i,
      /accenture\.wd3\.myworkdayjobs\.com/i,
      /indiacampus\.accenture/i,
    ],
    defaultCompany: "Accenture",
  },
  {
    portal: "LinkedIn",
    patterns: [/linkedin\.com/i, /jobs-listings@linkedin/i, /jobs-noreply@linkedin/i],
  },
  {
    portal: "Indeed",
    patterns: [/indeed\.com/i, /indeedemail\.com/i, /indeedapply/i],
  },
  {
    portal: "Naukri",
    patterns: [/naukri\.com/i, /naukrigulf/i, /infoedge/i],
  },
];

export function detectPortalFromText(
  sender: string,
  subject: string,
  body: string,
  url?: string
): { portal: ApplicationPortal; defaultCompany?: string } {
  const combined = `${sender} ${subject} ${body} ${url || ""}`;
  for (const matcher of PORTAL_MATCHERS) {
    if (matcher.patterns.some((rx) => rx.test(combined))) {
      return {
        portal: matcher.portal,
        defaultCompany: matcher.defaultCompany,
      };
    }
  }
  if (/myworkdayjobs\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|icims\.com/i.test(combined)) {
    return { portal: "Company Website" };
  }
  return { portal: "Company Website" };
}

export function extractApplicationId(text: string): string | null {
  const patterns = [
    // TCS NextStep Reference IDs (CT2026... / DT2026...)
    /\b((?:CT|DT)\d{9,12})\b/i,
    // Explicit prefixed application/requisition IDs
    /(?:Application\s*(?:ID|No|Number|#)|Requisition\s*(?:ID|No|#)|Job\s*(?:ID|Req|Code|#)|Candidate\s*(?:ID|Ref)|Reference\s*(?:ID|No|Code))\s*[:#-]*\s*([A-Z0-9][A-Z0-9_-]{3,22})/i,
    // Amazon / Wipro / Infosys / Accenture style codes
    /\b((?:AMZN|WPR|INFY|ACN|REQ|JOB|APP)-[A-Z0-9-]{4,18})\b/i,
    /\b(R-\d{5,10})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim().toUpperCase();
    }
  }
  return null;
}

export function extractCompanyName(
  sender: string,
  subject: string,
  body: string,
  defaultCompany?: string
): string {
  if (defaultCompany) return defaultCompany;

  // LinkedIn: "Your application was sent to Stripe" / "Candidate, your application was sent to Microsoft"
  const linkedInSent = subject.match(
    /application\s+(?:was\s+sent\s+to|to)\s+([A-Z][A-Za-z0-9\s&.-]{1,40}?)(?:\s+for\s+|\s*[-|!]|$)/i
  );
  if (linkedInSent && linkedInSent[1]) {
    return linkedInSent[1].trim();
  }

  // "Thank you for applying to <Company>" / "Your application at <Company>"
  const thankYouMatch = `${subject}\n${body}`.match(
    /(?:applying\s+to|application\s+(?:at|with|to)|interview\s+with|offer\s+from|opportunity\s+at)\s+([A-Z][A-Za-z0-9\s&]{1,35}?)(?:\s+for\s+|\s+as\s+|\s+is\s+|\s*[-.,!|\n]|$)/
  );
  if (thankYouMatch && thankYouMatch[1]) {
    const candidate = thankYouMatch[1].trim();
    if (
      !/^(the|our|your|this|a|an|position|role|team)$/i.test(candidate) &&
      candidate.length <= 36
    ) {
      return candidate;
    }
  }

  // Extract from Sender Display Name e.g. "Razorpay Recruiting <careers@razorpay.com>"
  const senderDisplay = sender.match(/^"?([^"<]+)"?\s*</);
  if (senderDisplay && senderDisplay[1]) {
    const cleaned = senderDisplay[1]
      .replace(
        /\b(Careers|Recruiting|Talent\s+Acquisition|HR|Hiring|Team|Jobs|NoReply|No-Reply|Workday|Greenhouse)\b/gi,
        ""
      )
      .replace(/[-|:,]+/g, " ")
      .trim();
    if (cleaned.length >= 2 && cleaned.length <= 36) {
      return cleaned;
    }
  }

  // Extract from domain
  const domainMatch = sender.match(/@([a-z0-9-]+)\.[a-z.]+/i);
  if (domainMatch && domainMatch[1]) {
    const domain = domainMatch[1].toLowerCase();
    if (
      !["gmail", "linkedin", "indeed", "naukri", "myworkdayjobs", "greenhouse", "lever"].includes(
        domain
      )
    ) {
      return domain.charAt(0).toUpperCase() + domain.slice(1);
    }
  }

  return "Employer Career Portal";
}

export function extractRoleTitle(subject: string, body: string): string {
  const combined = `${subject}\n${body}`;
  const patterns = [
    /(?:for\s+the\s+role\s+of|for\s+the\s+position\s+of|applied\s+for|application\s+for|interview\s+for|offer\s+for|role\s*:|position\s*:|job\s+title\s*:)\s*["']?([A-Z][A-Za-z0-9\s/,&().+-]{3,55}?)["']?(?:\s+at\s+|\s+with\s+|\s+\(Job|\s+\[|\s*[-.,!\n|]|$)/i,
    /\b((?:Senior\s+|Staff\s+|Lead\s+|Principal\s+|Associate\s+|Junior\s+)?(?:Software\s+Development\s+Engineer(?:\s+I{1,3}|\s+[123])?|Software\s+Engineer|Full\s+Stack\s+(?:Engineer|Developer)|Frontend\s+(?:Engineer|Developer)|Backend\s+(?:Engineer|Developer)|System\s+Engineer|Specialist\s+Programmer|Digital\s+Specialist\s+Engineer|Project\s+Engineer|Packaged\s+App\s+Development\s+Associate|Advanced\s+App\s+Engineering\s+Analyst|Data\s+Scientist|AI\s+Engineer|DevOps\s+Engineer|Cloud\s+Engineer))\b/i,
  ];

  for (const pattern of patterns) {
    const match = combined.match(pattern);
    if (match && match[1]) {
      const cleaned = match[1].replace(/\s+/g, " ").trim();
      if (cleaned.length >= 3 && cleaned.length <= 65) {
        return cleaned;
      }
    }
  }

  return "Software Engineer";
}

export function extractMeetingLink(text: string): string | null {
  const match = text.match(
    /https?:\/\/(?:meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}|teams\.microsoft\.com\/l\/meetup-join\/[^\s"'>)]+|[\w.-]*zoom\.us\/j\/[^\s"'>)]+|chime\.aws\/[0-9]+|[\w.-]*webex\.com\/[^\s"'>)]+)/i
  );
  return match ? match[0] : null;
}

export function extractDeadlineOrDate(text: string): string | null {
  const isoMatch = text.match(/\b(202[5-9]-[01]\d-[0-3]\d(?:T[0-2]\d:[0-5]\d)?)\b/);
  if (isoMatch) return isoMatch[1];

  const naturalMatch = text.match(
    /(?:deadline|complete\s+by|due\s+by|before|scheduled\s+for|on)\s*:?\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+202[5-9])/i
  );
  if (naturalMatch && naturalMatch[1]) {
    const parsed = new Date(naturalMatch[1]);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

export function parseJobEmail(email: RawEmailInput): ParsedJobEmail {
  const combined = `${email.subject}\n${email.bodyText}`;
  const lower = combined.toLowerCase();

  const isJobSignal =
    /application|applied|interview|assessment|hackerrank|codility|hirevue|online\s+test|coding\s+challenge|offer\s+letter|pleased\s+to\s+offer|unfortunately|not\s+moving\s+forward|other\s+candidates|requisition|nextstep|careers|recruiting|talent\s+acquisition/i.test(
      combined
    );

  const { portal, defaultCompany } = detectPortalFromText(
    email.sender,
    email.subject,
    email.bodyText
  );
  const company = extractCompanyName(
    email.sender,
    email.subject,
    email.bodyText,
    defaultCompany
  );
  const role = extractRoleTitle(email.subject, email.bodyText);
  const applicationId = extractApplicationId(combined);
  const extractedMeetingLink = extractMeetingLink(combined);
  const extractedDeadline = extractDeadlineOrDate(combined);

  let classification: ParsedJobEmail["classification"] = "CONFIRMATION";
  let mappedStatus: ApplicationStatus = "APPLIED";

  if (
    /unfortunately|not\s+moving\s+forward|not\s+selected|pursue\s+other\s+candidates|decided\s+not\s+to\s+proceed|regret\s+to\s+inform|will\s+not\s+be\s+taking\s+your\s+application\s+forward/i.test(
      lower
    )
  ) {
    classification = "REJECTION";
    mappedStatus = "REJECTED";
  } else if (
    /pleased\s+to\s+extend\s+an\s+offer|congratulations.*offer|offer\s+of\s+employment|provisional\s+offer\s+letter|welcome\s+aboard.*offer|job\s+offer\s+from/i.test(
      lower
    )
  ) {
    classification = "OFFER";
    mappedStatus = "OFFER";
  } else if (
    /online\s+assessment|coding\s+assessment|technical\s+assessment|hackerrank|codility|mettl|amcat|co-cubes|take-home\s+challenge|complete\s+the\s+assessment|nqt\s+assessment/i.test(
      lower
    )
  ) {
    classification = "ASSESSMENT";
    mappedStatus = "ASSESSMENT";
  } else if (
    /interview\s+invitation|schedule\s+your\s+interview|technical\s+interview|hiring\s+manager\s+round|loop\s+interview|panel\s+interview|interview\s+confirmed|invitation\s*:\s*.*interview/i.test(
      lower
    )
  ) {
    classification = "INTERVIEW";
    mappedStatus = "INTERVIEW";
  } else if (
    /application\s+received|thank\s+you\s+for\s+applying|application\s+was\s+sent|successfully\s+submitted|we\s+have\s+received\s+your\s+application|registered\s+for/i.test(
      lower
    )
  ) {
    classification = "CONFIRMATION";
    mappedStatus = "APPLIED";
  } else {
    classification = "UPDATE";
    mappedStatus = "UNDER_REVIEW";
  }

  return {
    isJobRelated: isJobSignal,
    company,
    role,
    portal,
    applicationId,
    classification,
    mappedStatus,
    extractedDeadline,
    extractedMeetingLink,
    confidence: applicationId ? 0.96 : 0.88,
  };
}
