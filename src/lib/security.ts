import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
export const SESSION_COOKIE_NAME = "careeros_session";
export const OAUTH_STATE_COOKIE_NAME = "careeros_oauth_state";

interface LocalRuntimeSecrets {
  encryptionKeyHex: string;
  sessionSecretHex: string;
  saltHex: string;
}

const globalForSecrets = globalThis as unknown as {
  __careerosRuntimeSecrets?: LocalRuntimeSecrets;
};

function getLocalSecretsFilePath(): string {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, ".careeros-secrets.json");
}

function getOrLoadRuntimeSecrets(): LocalRuntimeSecrets {
  if (globalForSecrets.__careerosRuntimeSecrets) {
    return globalForSecrets.__careerosRuntimeSecrets;
  }

  // If running against an isolated test DB, keep ephemeral random secrets in memory
  if (
    process.env.CAREEROS_DB_PATH &&
    !process.env.CAREEROS_DB_PATH.endsWith("careeros.db")
  ) {
    const ephemeral: LocalRuntimeSecrets = {
      encryptionKeyHex: crypto.randomBytes(32).toString("hex"),
      sessionSecretHex: crypto.randomBytes(32).toString("hex"),
      saltHex: crypto.randomBytes(16).toString("hex"),
    };
    globalForSecrets.__careerosRuntimeSecrets = ephemeral;
    return ephemeral;
  }

  const secretsPath = getLocalSecretsFilePath();
  if (fs.existsSync(secretsPath)) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(secretsPath, "utf8")
      ) as Partial<LocalRuntimeSecrets>;
      if (
        raw.encryptionKeyHex &&
        raw.encryptionKeyHex.length >= 64 &&
        raw.sessionSecretHex &&
        raw.sessionSecretHex.length >= 64 &&
        raw.saltHex &&
        raw.saltHex.length >= 32
      ) {
        const loaded: LocalRuntimeSecrets = {
          encryptionKeyHex: raw.encryptionKeyHex,
          sessionSecretHex: raw.sessionSecretHex,
          saltHex: raw.saltHex,
        };
        globalForSecrets.__careerosRuntimeSecrets = loaded;
        return loaded;
      }
    } catch {
      // Regenerate if corrupted
    }
  }

  const generated: LocalRuntimeSecrets = {
    encryptionKeyHex: crypto.randomBytes(32).toString("hex"),
    sessionSecretHex: crypto.randomBytes(32).toString("hex"),
    saltHex: crypto.randomBytes(16).toString("hex"),
  };

  try {
    fs.writeFileSync(secretsPath, JSON.stringify(generated, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Keep in memory if filesystem is read-only
  }

  globalForSecrets.__careerosRuntimeSecrets = generated;
  return generated;
}

function getDerivedEncryptionKey(): Buffer {
  const envSecret = process.env.CAREEROS_ENCRYPTION_KEY?.trim();
  const runtimeSecrets = getOrLoadRuntimeSecrets();
  const secretMaterial =
    envSecret && envSecret.length >= 16
      ? envSecret
      : runtimeSecrets.encryptionKeyHex;
  return crypto.scryptSync(secretMaterial, runtimeSecrets.saltHex, 32);
}

function getSessionSigningSecret(): string {
  const envSecret = process.env.CAREEROS_SESSION_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    return envSecret;
  }
  return getOrLoadRuntimeSecrets().sessionSecretHex;
}

/**
 * Encrypts sensitive OAuth tokens or secrets using AES-256-GCM with a random 96-bit IV
 * and 128-bit authentication tag. Stored format: v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 */
export function encryptSecret(plaintext: string): string {
  const key = getDerivedEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts an AES-256-GCM encrypted payload on the server side only.
 */
export function decryptSecret(encryptedPayload: string): string {
  const parts = encryptedPayload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted token format");
  }
  const [, ivHex, authTagHex, ciphertextHex] = parts;
  const key = getDerivedEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Hashes a password with random salt using scrypt
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

/**
 * Checks whether a master password has been configured in DB or environment.
 * Never falls back to a hardcoded password.
 */
export function isMasterPasswordConfigured(storedHash?: string | null): boolean {
  if (storedHash && storedHash.startsWith("scrypt:")) {
    return true;
  }
  const envPass = process.env.CAREEROS_MASTER_PASSWORD?.trim();
  return Boolean(envPass && envPass.length >= 8);
}

/**
 * Timing-safe password verification against stored scrypt hash or configured env password.
 * Never uses any hardcoded fallback password.
 */
export function verifyPassword(
  candidatePassword: string,
  storedHash?: string | null
): boolean {
  if (!candidatePassword || typeof candidatePassword !== "string") {
    return false;
  }

  if (storedHash && storedHash.startsWith("scrypt:")) {
    const [, salt, hashHex] = storedHash.split(":");
    if (!salt || !hashHex) return false;
    const candidateBuf = crypto.scryptSync(candidatePassword, salt, 64);
    const expectedBuf = Buffer.from(hashHex, "hex");
    if (candidateBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(candidateBuf, expectedBuf);
  }

  const envPassword = process.env.CAREEROS_MASTER_PASSWORD?.trim();
  if (!envPassword || envPassword.length < 8) {
    return false;
  }

  const a = crypto.createHash("sha256").update(candidatePassword).digest();
  const b = crypto.createHash("sha256").update(envPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

export interface SessionPayload {
  sub: "owner";
  iat: number;
  exp: number;
  jti: string;
}

/**
 * Creates an HMAC-SHA256 signed session token for single-user authentication
 */
export function createSessionToken(ttlSeconds = 60 * 60 * 24 * 7): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: "owner",
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomUUID(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const sig = crypto
    .createHmac("sha256", getSessionSigningSecret())
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

/**
 * Derives a session-bound CSRF token from the session JTI
 */
export function deriveCsrfToken(sessionJti: string): string {
  return crypto
    .createHmac("sha256", getSessionSigningSecret())
    .update(`csrf:${sessionJti}`)
    .digest("base64url");
}

/**
 * Verifies an HMAC-SHA256 signed session token
 */
export function verifySessionToken(
  token: string | undefined | null
): SessionPayload | null {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  const expectedSig = crypto
    .createHmac("sha256", getSessionSigningSecret())
    .update(payloadB64)
    .digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (
      parsed.sub !== "owner" ||
      typeof parsed.exp !== "number" ||
      parsed.exp <= now ||
      !parsed.jti
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export interface OAuthStatePayload {
  jti: string;
  nonce: string;
  iat: number;
  exp: number;
}

/**
 * Generates an expiring, HMAC-signed OAuth state token bound to the user's browser session JTI
 */
export function createOAuthStateToken(
  sessionJti: string,
  ttlSeconds = 600
): { stateToken: string; nonce: string } {
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload: OAuthStatePayload = {
    jti: sessionJti,
    nonce,
    iat: now,
    exp: now + ttlSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const sig = crypto
    .createHmac("sha256", getSessionSigningSecret())
    .update(`oauth_state:${payloadB64}`)
    .digest("base64url");
  return {
    stateToken: `${payloadB64}.${sig}`,
    nonce,
  };
}

/**
 * Validates OAuth state signature, expiry, browser-session JTI binding, and cookie nonce
 */
export function verifyOAuthStateToken(
  stateToken: string | undefined | null,
  expectedSessionJti: string,
  cookieNonce: string | undefined | null
): boolean {
  if (
    !stateToken ||
    !expectedSessionJti ||
    !cookieNonce ||
    !stateToken.includes(".")
  ) {
    return false;
  }
  const parts = stateToken.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return false;

  const expectedSig = crypto
    .createHmac("sha256", getSessionSigningSecret())
    .update(`oauth_state:${payloadB64}`)
    .digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return false;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as OAuthStatePayload;
    const now = Math.floor(Date.now() / 1000);
    if (parsed.exp <= now) return false;
    if (parsed.jti !== expectedSessionJti) return false;

    const nonceA = Buffer.from(parsed.nonce);
    const nonceB = Buffer.from(cookieNonce);
    if (nonceA.length !== nonceB.length) return false;
    return crypto.timingSafeEqual(nonceA, nonceB);
  } catch {
    return false;
  }
}

/**
 * Hashes an API token (such as the Chrome Extension capture token) with SHA-256 for storage
 */
export function hashApiToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Timing-safe comparison of a candidate extension API token against its stored SHA-256 hash
 */
export function verifyApiToken(
  candidateToken: string | undefined | null,
  storedSha256Hex: string | undefined | null
): boolean {
  if (!candidateToken || !storedSha256Hex) return false;
  const candidateHash = crypto
    .createHash("sha256")
    .update(candidateToken.trim())
    .digest();
  const expectedHash = Buffer.from(storedSha256Hex, "hex");
  if (candidateHash.length !== expectedHash.length) return false;
  return crypto.timingSafeEqual(candidateHash, expectedHash);
}

/**
 * Validates same-origin or CSRF token on state-changing HTTP methods (POST, PATCH, PUT, DELETE)
 */
export function verifyCsrfProtection(
  req: NextRequest,
  session: SessionPayload
): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }

  // 1. Check explicit session-bound CSRF token header if provided
  const csrfHeader = req.headers.get("x-careeros-csrf");
  if (csrfHeader) {
    const expectedCsrf = deriveCsrfToken(session.jti);
    const a = Buffer.from(csrfHeader);
    const b = Buffer.from(expectedCsrf);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }

  // 2. Check Origin / Referer header against allowed app origin
  const originHeader = req.headers.get("origin");
  const refererHeader = req.headers.get("referer");
  const reqOrigin = req.nextUrl.origin;
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).origin
    : reqOrigin;

  if (originHeader) {
    return originHeader === reqOrigin || originHeader === configuredOrigin;
  }

  if (refererHeader) {
    try {
      const refOrigin = new URL(refererHeader).origin;
      return refOrigin === reqOrigin || refOrigin === configuredOrigin;
    } catch {
      return false;
    }
  }

  // If neither Origin, Referer, nor X-CareerOS-CSRF is present on a mutation, block by default
  return false;
}

/**
 * Enforces server-side authentication (and CSRF protection on mutations) for private API routes.
 * Returns { session } if authorized, or { response: NextResponse(401/403) } if unauthorized.
 */
export function requireAuthenticatedSession(req: NextRequest): {
  session: SessionPayload | null;
  errorResponse: NextResponse | null;
} {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return {
      session: null,
      errorResponse: NextResponse.json(
        { error: "Authentication required. Please log in to CareerOS." },
        { status: 401 }
      ),
    };
  }

  if (!verifyCsrfProtection(req, session)) {
    return {
      session: null,
      errorResponse: NextResponse.json(
        { error: "CSRF validation failed for mutation request." },
        { status: 403 }
      ),
    };
  }

  return { session, errorResponse: null };
}

/**
 * Builds strict, non-wildcard CORS headers for the Chrome Extension endpoint.
 */
export function getExtensionCorsHeaders(
  req: NextRequest
): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const appOrigin = process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).origin
    : req.nextUrl.origin;
  const allowedExtensionOrigin =
    process.env.CAREEROS_ALLOWED_EXTENSION_ORIGIN?.trim() || "";

  const isAllowedOrigin =
    origin === appOrigin ||
    origin === req.nextUrl.origin ||
    (allowedExtensionOrigin !== "" && origin === allowedExtensionOrigin);

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-CareerOS-Extension-Token, X-CareerOS-CSRF",
    Vary: "Origin",
  };

  if (isAllowedOrigin && origin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}
