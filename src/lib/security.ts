import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";

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
  __careerosSessionRevokedFn?: (jti: string) => boolean;
  __careerosLoginAttempts?: Map<string, { count: number; resetAt: number }>;
};

export function registerSessionRevocationChecker(
  checker: (jti: string) => boolean
): void {
  globalForSecrets.__careerosSessionRevokedFn = checker;
}

export function isSessionJtiRevoked(jti: string): boolean {
  return globalForSecrets.__careerosSessionRevokedFn
    ? globalForSecrets.__careerosSessionRevokedFn(jti)
    : false;
}

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

function getEncryptionKeyMaterial(): string {
  const envSecret = process.env.CAREEROS_ENCRYPTION_KEY?.trim();
  if (envSecret !== undefined && envSecret !== "") {
    if (envSecret.length < 32) {
      throw new Error(
        "CAREEROS_ENCRYPTION_KEY must be at least 32 characters long."
      );
    }
    return envSecret;
  }
  return getOrLoadRuntimeSecrets().encryptionKeyHex;
}

function getSessionSigningSecret(): string {
  const envSecret = process.env.CAREEROS_SESSION_SECRET?.trim();
  if (envSecret !== undefined && envSecret !== "") {
    if (envSecret.length < 32) {
      throw new Error(
        "CAREEROS_SESSION_SECRET must be at least 32 characters long."
      );
    }
    return envSecret;
  }
  return getOrLoadRuntimeSecrets().sessionSecretHex;
}

function deriveAesKeyV2(salt: Buffer): Buffer {
  const material = getEncryptionKeyMaterial();
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(material, "utf8"),
      salt,
      Buffer.from("careeros-aes256-gcm-v2", "utf8"),
      32
    )
  );
}

function deriveAesKeyV1Legacy(): Buffer {
  const material = getEncryptionKeyMaterial();
  const runtimeSecrets = getOrLoadRuntimeSecrets();
  return crypto.scryptSync(material, runtimeSecrets.saltHex, 32);
}

/**
 * Encrypts sensitive OAuth tokens or secrets using AES-256-GCM with a per-ciphertext
 * 128-bit HKDF salt, 96-bit random IV, and 128-bit authentication tag.
 * Stored format: v2:<salt_hex>:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 */
export function encryptSecret(plaintext: string): string {
  const salt = crypto.randomBytes(16);
  const key = deriveAesKeyV2(salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `v2:${salt.toString("hex")}:${iv.toString("hex")}:${authTag.toString(
    "hex"
  )}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts an AES-256-GCM encrypted payload (v2 HKDF or legacy v1) on the server side only.
 */
export function decryptSecret(encryptedPayload: string): string {
  const parts = encryptedPayload.split(":");

  if (parts.length === 5 && parts[0] === "v2") {
    const [, saltHex, ivHex, authTagHex, ciphertextHex] = parts;
    const salt = Buffer.from(saltHex, "hex");
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const ciphertext = Buffer.from(ciphertextHex, "hex");
    const key = deriveAesKeyV2(salt);

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }

  if (parts.length === 4 && parts[0] === "v1") {
    const [, ivHex, authTagHex, ciphertextHex] = parts;
    const key = deriveAesKeyV1Legacy();
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

  throw new Error("Invalid encrypted token format");
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
export function isMasterPasswordConfigured(
  storedHash?: string | null
): boolean {
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
 * Verifies an HMAC-SHA256 signed session token and ensures it has not been revoked
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
    if (isSessionJtiRevoked(parsed.jti)) {
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
): { stateToken: string; nonce: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const exp = now + ttlSeconds;
  const payload: OAuthStatePayload = {
    jti: sessionJti,
    nonce,
    iat: now,
    exp,
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
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Validates OAuth state signature, expiry, browser-session JTI binding, and cookie nonce
 */
export function verifyOAuthStateToken(
  stateToken: string | undefined | null,
  expectedSessionJti: string,
  cookieNonce: string | undefined | null
): { valid: boolean; nonce: string | null } {
  if (
    !stateToken ||
    !expectedSessionJti ||
    !cookieNonce ||
    !stateToken.includes(".")
  ) {
    return { valid: false, nonce: null };
  }
  const parts = stateToken.split(".");
  if (parts.length !== 2) return { valid: false, nonce: null };
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return { valid: false, nonce: null };

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
    return { valid: false, nonce: null };
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as OAuthStatePayload;
    const now = Math.floor(Date.now() / 1000);
    if (parsed.exp <= now) return { valid: false, nonce: null };
    if (parsed.jti !== expectedSessionJti) return { valid: false, nonce: null };

    const nonceA = Buffer.from(parsed.nonce);
    const nonceB = Buffer.from(cookieNonce);
    if (
      nonceA.length !== nonceB.length ||
      !crypto.timingSafeEqual(nonceA, nonceB)
    ) {
      return { valid: false, nonce: null };
    }
    return { valid: true, nonce: parsed.nonce };
  } catch {
    return { valid: false, nonce: null };
  }
}

/**
 * Hashes an API token or nonce with SHA-256 for storage
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
 * Determines whether cookies should set the Secure attribute based on actual HTTPS transport.
 * Ensures local `npm run start` over http://localhost:3000 remains functional while HTTPS sets Secure.
 */
export function isSecureCookieContext(req: NextRequest): boolean {
  if (req.nextUrl.protocol === "https:") return true;
  if (req.headers.get("x-forwarded-proto") === "https") return true;
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configuredUrl && configuredUrl.startsWith("https://")) return true;
  return false;
}

/**
 * Verifies Origin / Referer headers belong strictly to the CareerOS application origin
 */
export function verifySameOriginRequest(req: NextRequest): boolean {
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

  return false;
}

/**
 * Validates same-origin AND session-bound CSRF token on state-changing HTTP methods.
 * Immediately rejects any mismatched Origin/Referer header.
 */
export function verifyCsrfProtection(
  req: NextRequest,
  session: SessionPayload
): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }

  // 1. If Origin or Referer is present, it MUST match our app origin (never bypassable)
  const hasOriginOrReferer = Boolean(
    req.headers.get("origin") || req.headers.get("referer")
  );
  if (hasOriginOrReferer && !verifySameOriginRequest(req)) {
    return false;
  }

  // 2. Require explicit session-bound CSRF token header on cookie-authenticated mutations
  const csrfHeader = req.headers.get("x-careeros-csrf");
  if (!csrfHeader) {
    return false;
  }

  const expectedCsrf = deriveCsrfToken(session.jti);
  const a = Buffer.from(csrfHeader);
  const b = Buffer.from(expectedCsrf);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * In-memory brute-force protection for single-user master password login
 */
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function getLoginAttemptStore(): Map<
  string,
  { count: number; resetAt: number }
> {
  if (!globalForSecrets.__careerosLoginAttempts) {
    globalForSecrets.__careerosLoginAttempts = new Map();
  }
  return globalForSecrets.__careerosLoginAttempts;
}

export function getClientRateLimitKey(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = req.headers.get("x-real-ip")?.trim();
  return fwd || realIp || "local-owner";
}

export function checkLoginRateLimit(key: string): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const store = getLoginAttemptStore();
  const entry = store.get(key);
  const now = Date.now();
  if (!entry || entry.resetAt <= now) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= MAX_FAILED_LOGIN_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordFailedLoginAttempt(key: string): void {
  const store = getLoginAttemptStore();
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
    store.set(key, entry);
  }
}

export function clearFailedLoginAttempts(key: string): void {
  getLoginAttemptStore().delete(key);
}

/**
 * Enforces server-side authentication (and CSRF protection on mutations) for private API routes.
 */
export function requireAuthenticatedSession(req: NextRequest): {
  session: SessionPayload | null;
  errorResponse: Response | null;
} {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return {
      session: null,
      errorResponse: Response.json(
        { error: "Authentication required. Please log in to CareerOS." },
        { status: 401 }
      ),
    };
  }

  if (!verifyCsrfProtection(req, session)) {
    return {
      session: null,
      errorResponse: Response.json(
        { error: "CSRF validation failed for mutation request." },
        { status: 403 }
      ),
    };
  }

  return { session, errorResponse: null };
}

/**
 * Checks whether the request's Origin (if present) is explicitly permitted for the extension API.
 */
export function isOriginAllowedForExtension(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // Non-browser / direct extension contexts without Origin header

  const appOrigin = process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).origin
    : req.nextUrl.origin;
  const allowedExtensionOrigin =
    process.env.CAREEROS_ALLOWED_EXTENSION_ORIGIN?.trim() || "";

  return (
    origin === appOrigin ||
    origin === req.nextUrl.origin ||
    (allowedExtensionOrigin !== "" && origin === allowedExtensionOrigin)
  );
}

/**
 * Builds strict, non-wildcard CORS headers for the Chrome Extension endpoint.
 */
export function getExtensionCorsHeaders(
  req: NextRequest
): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const isAllowedOrigin = origin !== "" && isOriginAllowedForExtension(req);

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-CareerOS-Extension-Token, X-CareerOS-CSRF",
    Vary: "Origin",
  };

  if (isAllowedOrigin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}
