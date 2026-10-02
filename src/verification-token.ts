import { createHash, randomBytes } from "node:crypto";

export interface VerificationToken {
  /** For constructing the verification link only. Never persist or log this value. */
  rawToken: string;
  /** SHA-256 hex digest; persist this instead of the raw token. */
  tokenHash: string;
}

/** Hash the exact token string without trimming or other normalization. */
export function hashVerificationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Generate 256 bits of entropy, encoded without URL-unsafe characters or padding. */
export function generateVerificationToken(): VerificationToken {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashVerificationToken(rawToken) };
}
