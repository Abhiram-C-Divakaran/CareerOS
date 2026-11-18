import crypto from "node:crypto";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
export const SESSION_COOKIE_NAME = "careeros_session";

function getDerivedEncryptionKey(): Buffer {
  const secret =
    process.env.CAREEROS_ENCRYPTION_KEY ||
    "careeros-local-aes256-gcm-secret-key-change-in-prod";
  return crypto.scryptSync(secret, "careeros-aes-gcm-salt-v1", 32);
}

function getSessionSigningSecret(): string {
  return (
    process.env.CAREEROS_SESSION_SECRET ||
    "careeros-hmac-sha256-session-signing-secret-2026"
  );
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
 * Timing-safe password verification against stored scrypt hash or master password
 */
export function verifyPassword(
  candidatePassword: string,
  storedHash?: string | null
): boolean {
  if (storedHash && storedHash.startsWith("scrypt:")) {
    const [, salt, hashHex] = storedHash.split(":");
    if (!salt || !hashHex) return false;
    const candidateBuf = crypto.scryptSync(candidatePassword, salt, 64);
    const expectedBuf = Buffer.from(hashHex, "hex");
    if (candidateBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(candidateBuf, expectedBuf);
  }

  const masterPassword =
    process.env.CAREEROS_MASTER_PASSWORD || "careeros-admin-2026";
  const a = crypto.createHash("sha256").update(candidatePassword).digest();
  const b = crypto.createHash("sha256").update(masterPassword).digest();
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
 * Verifies an HMAC-SHA256 signed session token
 */
export function verifySessionToken(
  token: string | undefined | null
): SessionPayload | null {
  if (!token || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".");
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
    if (parsed.sub !== "owner" || parsed.exp <= now) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
