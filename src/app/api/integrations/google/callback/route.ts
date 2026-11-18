import { NextRequest, NextResponse } from "next/server";
import { exchangeGoogleCodeForTokens } from "@/lib/google-integration";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  if (error) {
    return NextResponse.redirect(
      `${baseUrl}/?oauth_error=${encodeURIComponent(error)}`
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${baseUrl}/?oauth_error=${encodeURIComponent("Missing OAuth authorization code")}`
    );
  }

  try {
    const { accountEmail } = await exchangeGoogleCodeForTokens(code);
    return NextResponse.redirect(
      `${baseUrl}/?oauth_connected=${encodeURIComponent(accountEmail)}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "OAuth callback failed";
    return NextResponse.redirect(
      `${baseUrl}/?oauth_error=${encodeURIComponent(msg)}`
    );
  }
}
