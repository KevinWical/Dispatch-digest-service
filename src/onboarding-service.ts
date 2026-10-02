import { findOrCreateUser } from "./user-persistence.js";
import { replaceVerificationRequest } from "./verification-persistence.js";
import { createManagementRequest } from "./management-persistence.js";

/** Internal delivery material only. Never log or expose this in a public HTTP response. */
export interface OnboardingCredential {
  email: string;
  kind: "verification" | "management";
  rawCredential: string;
}

export function createOnboardingService(
  verificationLifetimeMs: number,
  env: NodeJS.ProcessEnv = process.env,
): (email: string) => Promise<OnboardingCredential> {
  if (!Number.isSafeInteger(verificationLifetimeMs) || verificationLifetimeMs <= 0 ||
      !Number.isFinite(new Date(Date.now() + verificationLifetimeMs).getTime())) {
    throw new Error("Verification credential lifetime must be a positive whole number of milliseconds within the supported date range.");
  }
  return async (email) => {
    const user = await findOrCreateUser(email, env);
    if (user.isVerified) {
      return { email: user.email, kind: "management", rawCredential: await createManagementRequest(user.id, env) };
    }
    const expiresAt = new Date(Date.now() + verificationLifetimeMs);
    return { email: user.email, kind: "verification", rawCredential: await replaceVerificationRequest(user.id, expiresAt, env) };
  };
}
