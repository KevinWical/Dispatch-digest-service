import { beforeEach, describe, expect, it, vi } from "vitest";
import { withOnboardingServer } from "./http-helper.js";
import { createOnboardingService } from "../src/onboarding-service.js";
import { findOrCreateUser } from "../src/user-persistence.js";
import { replaceVerificationRequest } from "../src/verification-persistence.js";
import { createManagementRequest } from "../src/management-persistence.js";

vi.mock("../src/user-persistence.js", () => ({ findOrCreateUser: vi.fn() }));
vi.mock("../src/verification-persistence.js", () => ({ replaceVerificationRequest: vi.fn() }));
vi.mock("../src/management-persistence.js", () => ({ createManagementRequest: vi.fn() }));

describe("onboarding HTTP", () => {
  beforeEach(() => vi.resetAllMocks());

  it("has the identical public response for new, existing unverified, and verified identities", async () => {
    vi.mocked(findOrCreateUser)
      .mockResolvedValueOnce({ id: "1", email: "person.name+tag@gmail.com", isVerified: false })
      .mockResolvedValueOnce({ id: "1", email: "person.name+tag@gmail.com", isVerified: false })
      .mockResolvedValueOnce({ id: "2", email: "person.name+tag@gmail.com", isVerified: true });
    vi.mocked(replaceVerificationRequest).mockResolvedValue("secret-verification");
    vi.mocked(createManagementRequest).mockResolvedValue("secret-management");
    await withOnboardingServer(createOnboardingService(60_000), async (url) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "Person.Name+tag@gmail.com" }) });
        expect(response.status).toBe(202);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ message: "Check your inbox for the next step" });
      }
    });
    expect(replaceVerificationRequest).toHaveBeenCalledTimes(2);
    expect(createManagementRequest).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { email: 1 }, { email: "" }, { email: "bad-email" }, []])("rejects invalid input before business logic (%j)", async (body) => {
    const onboard = vi.fn().mockResolvedValue(undefined);
    await withOnboardingServer(onboard, async (url) => {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    });
    expect(onboard).not.toHaveBeenCalled();
  });

  it.each([
    { body: '{"email":', type: "application/json", status: 400 },
    { body: "not json", type: "text/plain", status: 415 },
    { body: JSON.stringify({ email: "a".repeat(9000) }), type: "application/json", status: 413 },
  ])("rejects malformed transport input with $status", async ({ body, type, status }) => {
    const onboard = vi.fn().mockResolvedValue(undefined);
    await withOnboardingServer(onboard, async (url) => {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": type }, body });
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).not.toContain(body);
    });
    expect(onboard).not.toHaveBeenCalled();
  });

  it("does not expose credential or identity details on service failure", async () => {
    const onboard = vi.fn().mockRejectedValue(new Error("user@example.test secret-token verified=true"));
    await withOnboardingServer(onboard, async (url) => {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "user@example.test" }) });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Unable to process onboarding right now. Please try again." });
    });
  });
});
