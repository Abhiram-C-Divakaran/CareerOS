import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  verifyPassword,
  verifySessionToken,
} from "@/lib/security";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  return NextResponse.json({
    authenticated: Boolean(session),
    singleUserMode: true,
    sessionExpiresAt: session
      ? new Date(session.exp * 1000).toISOString()
      : null,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: "login" | "logout";
      password?: string;
    };

    if (body.action === "logout") {
      const res = NextResponse.json({ ok: true, authenticated: false });
      res.cookies.delete(SESSION_COOKIE_NAME);
      return res;
    }

    const db = getDb();
    const storedHashRow = db
      .prepare(`SELECT value FROM system_settings WHERE key = 'master_password_hash'`)
      .get();
    const storedHash = storedHashRow ? String(storedHashRow.value) : null;

    if (!body.password || !verifyPassword(body.password, storedHash)) {
      return NextResponse.json(
        { error: "Invalid master password for this CareerOS instance." },
        { status: 401 }
      );
    }

    const sessionToken = createSessionToken();
    const res = NextResponse.json({
      ok: true,
      authenticated: true,
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
