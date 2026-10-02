import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOnboardingService } from "../src/onboarding-service.js";
import { findOrCreateUser } from "../src/user-persistence.js";
import { replaceVerificationRequest } from "../src/verification-persistence.js";
import { createManagementRequest } from "../src/management-persistence.js";

vi.mock("../src/user-persistence.js", () => ({ findOrCreateUser: vi.fn() }));
vi.mock("../src/verification-persistence.js", () => ({ replaceVerificationRequest: vi.fn() }));
vi.mock("../src/management-persistence.js", () => ({ createManagementRequest: vi.fn() }));

describe("onboarding service", () => {
  beforeEach(() => vi.resetAllMocks());

  it("issues verification for an unverified identity using configured lifetime", async () => {
    vi.mocked(findOrCreateUser).mockResolvedValue({ id: "1", email: "person.name+tag@gmail.com", isVerified: false });
    vi.mocked(replaceVerificationRequest).mockResolvedValue("synthetic-verification");
    const now = Date.now();
    const result = await createOnboardingService(60_000, {})("Person.Name+tag@gmail.com");
    expect(findOrCreateUser).toHaveBeenCalledWith("Person.Name+tag@gmail.com", {});
    expect(result).toEqual({ email: "person.name+tag@gmail.com", kind: "verification", rawCredential: "synthetic-verification" });
    const [id, expiresAt, env] = vi.mocked(replaceVerificationRequest).mock.calls[0]!;
    expect(id).toBe("1");
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(now + 60_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(env).toEqual({});
    expect(createManagementRequest).not.toHaveBeenCalled();
  });

  it("issues management for a verified identity without replacing verification", async () => {
    vi.mocked(findOrCreateUser).mockResolvedValue({ id: "2", email: "user@example.test", isVerified: true });
    vi.mocked(createManagementRequest).mockResolvedValue("synthetic-management");
    expect(await createOnboardingService(60_000, {})("USER@EXAMPLE.TEST")).toEqual({
      email: "user@example.test", kind: "management", rawCredential: "synthetic-management",
    });
    expect(createManagementRequest).toHaveBeenCalledWith("2", {});
    expect(replaceVerificationRequest).not.toHaveBeenCalled();
  });

  it("stops if identity lookup fails", async () => {
    vi.mocked(findOrCreateUser).mockRejectedValue(new Error("Lookup failed"));
    await expect(createOnboardingService(60_000)("user@example.test")).rejects.toThrow("Lookup failed");
    expect(replaceVerificationRequest).not.toHaveBeenCalled();
    expect(createManagementRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])("propagates credential failure for verified=%s", async (isVerified) => {
    vi.mocked(findOrCreateUser).mockResolvedValue({ id: "1", email: "user@example.test", isVerified });
    vi.mocked(replaceVerificationRequest).mockRejectedValue(new Error("Credential failed"));
    vi.mocked(createManagementRequest).mockRejectedValue(new Error("Credential failed"));
    await expect(createOnboardingService(60_000)("user@example.test")).rejects.toThrow("Credential failed");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])("requires an explicit valid lifetime (%s)", (duration) => {
    expect(() => createOnboardingService(duration)).toThrow("Verification credential lifetime");
  });
});
