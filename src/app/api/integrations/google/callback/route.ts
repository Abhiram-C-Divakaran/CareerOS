import { NextRequest, NextResponse } from "next/server";
import { consumeOAuthStateNonce, getDb } from "@/lib/db";
import { exchangeGoogleCodeForTokens } from "@/lib/google-integration";
import {
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  verifyOAuthStateToken,
  verifySessionToken,
} from "@/lib/security";

export async function GET(req: NextRequest) {
  getDb();
  const sessionToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json(
      {
        error:
          "Authentication required before completing Google OAuth callback.",
      },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const cookieNonce = req.cookies.get(OAUTH_STATE_COOKIE_NAME)?.value;
  const stateCheck = verifyOAuthStateToken(state, session.jti, cookieNonce);

  if (
    !stateCheck.valid ||
    !stateCheck.nonce ||
    !consumeOAuthStateNonce(stateCheck.nonce, session.jti)
  ) {
    const invalidRes = NextResponse.redirect(
      `${baseUrl}/?oauth_error=${encodeURIComponent(
        "Invalid, expired, or already used OAuth state parameter."
      )}`
    );
    invalidRes.cookies.delete(OAUTH_STATE_COOKIE_NAME);
    return invalidRes;
  }

  if (error) {
    const errRes = NextResponse.redirect(
      `${baseUrl}/?oauth_error=${encodeURIComponent(
        error.slice(0, 80)
      )}`
    );
    errRes.cookies.delete(OAUTH_STATE_COOKIE_NAME);
    return errRes;
  }

  if (!code) {
    const missingRes = NextResponse.redirect(
      `${baseUrl}/?oauth_error=${encodeURIComponent(
        "Missing OAuth authorization code"
      )}`
    );
    missingRes.cookies.delete(OAUTH_STATE_COOKIE_NAME);
    return missingRes;
  }

  try {
    const { accountEmail } = await exchangeGoogleCodeForTokens(code);
    const okRes = NextResponse.redirect(
      `${baseUrl}/?oauth_connected=${encodeURIComponent(accountEmail)}`
    );
    okRes.cookies.delete(OAUTH_STATE_COOKIE_NAME);
    return okRes;
  } catch {
    const failRes = NextResponse.redirect(
      `${baseUrl}/?oauth_error=${encodeURIComponent(
        "Google OAuth token exchange failed. Check server logs and credentials."
      )}`
    );
    failRes.cookies.delete(OAUTH_STATE_COOKIE_NAME);
    return failRes;
  }
}
