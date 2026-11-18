/**
 * CareerOS User-Authorized Portal Metadata Extractor
 * Strictly reads visible DOM fields on user request. Never interacts with CAPTCHAs,
 * login forms, or anti-bot challenges.
 */
(function () {
  function extractPageApplicationMetadata() {
    const url = window.location.href;
    const hostname = window.location.hostname.toLowerCase();
    const title = document.title || "";
    const bodyText = (document.body ? document.body.innerText : "").slice(0, 6000);

    // Safety check: never operate on CAPTCHA or verification gates
    const hasChallenge = Boolean(
      document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], #cf-challenge-running'
      )
    );
    if (hasChallenge) {
      return {
        blockedByChallenge: true,
        reason:
          "Security/CAPTCHA challenge detected on page. Complete verification manually in your browser before capturing.",
      };
    }

    let portal = "Company Website";
    let company = "";

    if (hostname.includes("amazon.jobs")) {
      portal = "Amazon Careers";
      company = "Amazon";
    } else if (hostname.includes("tcs.com")) {
      portal = "TCS NextStep";
      company = "Tata Consultancy Services (TCS)";
    } else if (hostname.includes("wipro.com")) {
      portal = "Wipro Careers";
      company = "Wipro";
    } else if (hostname.includes("infosys.com")) {
      portal = "Infosys";
      company = "Infosys";
    } else if (hostname.includes("accenture.com")) {
      portal = "Accenture";
      company = "Accenture";
    } else if (hostname.includes("linkedin.com")) {
      portal = "LinkedIn";
    } else if (hostname.includes("indeed.com")) {
      portal = "Indeed";
    } else if (hostname.includes("naukri.com")) {
      portal = "Naukri";
    }

    const h1 = document.querySelector("h1");
    const role = h1 ? h1.innerText.trim().slice(0, 90) : title.split("|")[0].split("-")[0].trim();

    if (!company) {
      const companyNode = document.querySelector(
        '[data-testid="inlineHeader-companyName"], .job-details-jobs-unified-top-card__company-name, .jd-header-comp-name'
      );
      company = companyNode ? companyNode.textContent.trim() : hostname.replace(/^www\./, "");
    }

    // Extract visible Application / Requisition ID
    let portalApplicationId = null;
    const idPatterns = [
      /\b((?:CT|DT)\d{9,12})\b/i,
      /(?:Job\s*ID|Application\s*ID|Requisition\s*ID|Req\s*ID|Ref\s*ID)\s*[:#-]*\s*([A-Z0-9_-]{4,22})/i,
      /\/jobs\/(\d{5,12})/i,
    ];
    for (const pattern of idPatterns) {
      const match = `${url}\n${bodyText}`.match(pattern);
      if (match && match[1]) {
        portalApplicationId = match[1].toUpperCase();
        break;
      }
    }

    // Detect visible candidate portal status if on "My Applications" dashboard
    let status = "APPLIED";
    if (/offer\s+extended|provisional\s+offer/i.test(bodyText)) {
      status = "OFFER";
    } else if (/interview\s+scheduled|technical\s+interview/i.test(bodyText)) {
      status = "INTERVIEW";
    } else if (/assessment\s+pending|online\s+assessment|coding\s+test/i.test(bodyText)) {
      status = "ASSESSMENT";
    } else if (/under\s+review|in\s+progress|application\s+submitted/i.test(bodyText)) {
      status = "UNDER_REVIEW";
    } else if (/not\s+selected|no\s+longer\s+under\s+consideration/i.test(bodyText)) {
      status = "REJECTED";
    }

    return {
      blockedByChallenge: false,
      company,
      role,
      portal,
      portalApplicationId,
      sourceUrl: url,
      status,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "CAREEROS_EXTRACT_PAGE") {
      sendResponse(extractPageApplicationMetadata());
    }
    return true;
  });
})();
