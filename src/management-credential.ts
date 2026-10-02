import { createHash, randomBytes } from "node:crypto";

/** Hash the exact credential string for persistence and future validation. */
export function hashManagementCredential(rawCredential: string): string {
  return createHash("sha256").update(rawCredential, "utf8").digest("hex");
}

/** Raw credentials are link material only: never persist or log them. */
export function generateManagementCredential(): { rawCredential: string; credentialHash: string } {
  const rawCredential = randomBytes(32).toString("base64url");
  return { rawCredential, credentialHash: hashManagementCredential(rawCredential) };
}
