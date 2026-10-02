/** Validate conventional dot-atom email input without provider-specific normalization. */
export function parseOnboardingEmail(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body) || !("email" in body)) {
    throw new Error("Request must contain an email string.");
  }
  const email = body.email;
  if (typeof email !== "string") throw new Error("Request must contain an email string.");
  const parts = email.split("@");
  const local = parts[0];
  const domain = parts[1];
  const localPattern = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  const domainLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
  if (email.length > 254 || parts.length !== 2 || !local || local.length > 64 ||
      !localPattern.test(local) || !domain || domain.split(".").length < 2 ||
      !domain.split(".").every((label) => domainLabel.test(label))) {
    throw new Error("Email must be a nonempty, valid email address.");
  }
  return email;
}
