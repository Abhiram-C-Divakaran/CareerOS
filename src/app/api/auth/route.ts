import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  deriveCsrfToken,
  isMasterPasswordConfigured,
  OAUTH_STATE_COOKIE_NAME,
  requireAuthenticatedSession,
  SESSION_COOKIE_NAME,
  verifyCsrfProtection,
  verifyPassword,
  verifySessionToken,
} from "@/lib/security";
import {
  getExtensionTokenHash,
  getMasterPasswordHash,
  rotateExtensionApiToken,
  setMasterPasswordHash,
} from "@/lib/db";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);
  const storedHash = getMasterPasswordHash();
  const passwordConfigured = isMasterPasswordConfigured(storedHash);

  return NextResponse.json({
    authenticated: Boolean(session),
    passwordConfigured,
    singleUserMode: true,
    csrfToken: session ? deriveCsrfToken(session.jti) : null,
    extensionTokenConfigured: Boolean(getExtensionTokenHash()),
    sessionExpiresAt: session
      ? new Date(session.exp * 1000).toISOString()
      : null,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: "login" | "logout" | "setup" | "rotate_extension_token";
      password?: string;
    };

    if (body.action === "logout") {
      const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
      const session = verifySessionToken(token);
      if (session && !verifyCsrfProtection(req, session)) {
        return NextResponse.json(
          { error: "CSRF validation failed for logout request." },
          { status: 403 }
        );
      }
      const res = NextResponse.json({ ok: true, authenticated: false });
      res.cookies.delete(SESSION_COOKIE_NAME);
      res.cookies.delete(OAUTH_STATE_COOKIE_NAME);
      return res;
    }

    if (body.action === "rotate_extension_token") {
      const { errorResponse } = requireAuthenticatedSession(req);
      if (errorResponse) return errorResponse;

      const extensionToken = rotateExtensionApiToken();
      return NextResponse.json({
        ok: true,
        extensionToken,
      });
    }

    const storedHash = getMasterPasswordHash();
    const configured = isMasterPasswordConfigured(storedHash);

    if (body.action === "setup") {
      if (configured) {
        return NextResponse.json(
          { error: "Master password is already configured for this CareerOS instance." },
          { status: 400 }
        );
      }
      if (
        !body.password ||
        typeof body.password !== "string" ||
        body.password.trim().length < 8
      ) {
        return NextResponse.json(
          { error: "Master password must be at least 8 characters long." },
          { status: 400 }
        );
      }

      setMasterPasswordHash(body.password.trim());
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
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });
      return res;
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

    if (!body.password || !verifyPassword(body.password, storedHash)) {
      return NextResponse.json(
        { error: "Invalid master password for this CareerOS instance." },
        { status: 401 }
      );
    }

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
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });

    return res;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Authentication error" },
      { status: 500 }
    );
  }
}
