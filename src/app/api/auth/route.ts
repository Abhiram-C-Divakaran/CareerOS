import { NextRequest, NextResponse } from "next/server";
import {
  checkLoginRateLimit,
  clearFailedLoginAttempts,
  createSessionToken,
  deriveCsrfToken,
  getClientRateLimitKey,
  isMasterPasswordConfigured,
  isSecureCookieContext,
  OAUTH_STATE_COOKIE_NAME,
  recordFailedLoginAttempt,
  requireAuthenticatedSession,
  SESSION_COOKIE_NAME,
  verifyCsrfProtection,
  verifyPassword,
  verifySameOriginRequest,
  verifySessionToken,
} from "@/lib/security";
import {
  getDb,
  getExtensionTokenHash,
  getMasterPasswordHash,
  revokeSessionJti,
  rotateExtensionApiToken,
  setMasterPasswordHash,
} from "@/lib/db";
import { safeParseJsonBody, ValidationError } from "@/lib/validation";

export async function GET(req: NextRequest) {
  getDb(); // Ensure session revocation checker is registered
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);
  const storedHash = getMasterPasswordHash();
  const passwordConfigured = isMasterPasswordConfigured(storedHash);

  return NextResponse.json({
    authenticated: Boolean(session),
    passwordConfigured,
    singleUserMode: true,
    csrfToken: session ? deriveCsrfToken(session.jti) : null,
    extensionTokenConfigured: session ? Boolean(getExtensionTokenHash()) : null,
    sessionExpiresAt: session
      ? new Date(session.exp * 1000).toISOString()
      : null,
  });
}

export async function POST(req: NextRequest) {
  getDb(); // Ensure session revocation checker is registered
  try {
    const body = await safeParseJsonBody(req);
    const action = body.action;
    const password =
      typeof body.password === "string" ? body.password : undefined;

    if (
      action !== "login" &&
      action !== "logout" &&
      action !== "setup" &&
      action !== "rotate_extension_token"
    ) {
      return NextResponse.json(
        {
          error:
            "Invalid auth action. Allowed: login, logout, setup, rotate_extension_token.",
        },
        { status: 400 }
      );
    }

    if (action === "logout") {
      const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
      const session = verifySessionToken(token);
      if (session) {
        if (!verifyCsrfProtection(req, session)) {
          return NextResponse.json(
            { error: "CSRF validation failed for logout request." },
            { status: 403 }
          );
        }
        // Server-side revocation so replaying the old cookie immediately fails with 401
        revokeSessionJti(session.jti, session.exp);
      } else if (!verifySameOriginRequest(req)) {
        return NextResponse.json(
          { error: "Cross-origin logout request blocked." },
          { status: 403 }
        );
      }

      const res = NextResponse.json({ ok: true, authenticated: false });
      res.cookies.delete(SESSION_COOKIE_NAME);
      res.cookies.delete(OAUTH_STATE_COOKIE_NAME);
      return res;
    }

    if (action === "rotate_extension_token") {
      const { errorResponse } = requireAuthenticatedSession(req);
      if (errorResponse) {
        return NextResponse.json(await errorResponse.json(), {
          status: errorResponse.status,
        });
      }

      const extensionToken = rotateExtensionApiToken();
      return NextResponse.json({
        ok: true,
        extensionToken,
      });
    }

    // Enforce same-origin protection on login and initial setup to prevent login/setup CSRF
    if (!verifySameOriginRequest(req)) {
      return NextResponse.json(
        { error: "Cross-origin authentication request blocked." },
        { status: 403 }
      );
    }

    const storedHash = getMasterPasswordHash();
    const configured = isMasterPasswordConfigured(storedHash);
    const secureCookie = isSecureCookieContext(req);

    if (action === "setup") {
      if (configured) {
        return NextResponse.json(
          {
            error:
              "Master password is already configured for this CareerOS instance.",
          },
          { status: 400 }
        );
      }
      if (!password || password.trim().length < 8) {
        return NextResponse.json(
          { error: "Master password must be at least 8 characters long." },
          { status: 400 }
        );
      }

      setMasterPasswordHash(password.trim());
      const sessionToken = createSessionToken();
      const verified = verifySessionToken(sessionToken)!;
      const res = NextResponse.json({
        ok: true,
        authenticated: true,
        passwordConfigured: true,
        csrfToken: deriveCsrfToken(verified.jti),
      });

      res.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookie,
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });
      return res;
    }

    // action === "login"
    const rateKey = getClientRateLimitKey(req);
    const rateCheck = checkLoginRateLimit(rateKey);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          error: `Too many failed login attempts. Try again in ${rateCheck.retryAfterSeconds} seconds.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rateCheck.retryAfterSeconds) },
        }
      );
    }

    if (!configured) {
      return NextResponse.json(
        {
          error:
            "Master password is not configured yet. Please complete initial password setup.",
          requiresSetup: true,
        },
        { status: 403 }
      );
    }

    if (!password || !verifyPassword(password, storedHash)) {
      recordFailedLoginAttempt(rateKey);
      return NextResponse.json(
        { error: "Invalid master password for this CareerOS instance." },
        { status: 401 }
      );
    }

    clearFailedLoginAttempts(rateKey);
    const sessionToken = createSessionToken();
    const verified = verifySessionToken(sessionToken)!;
    const res = NextResponse.json({
      ok: true,
      authenticated: true,
      passwordConfigured: true,
      csrfToken: deriveCsrfToken(verified.jti),
    });

    res.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie,
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });

    return res;
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Authentication error" },
      { status: 500 }
    );
  }
}
