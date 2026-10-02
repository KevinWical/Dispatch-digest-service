import { describe, expect, it } from "vitest";
import { parseOnboardingEmail } from "../src/onboarding-input.js";

describe("onboarding input", () => {
  it.each([null, [], {}, { email: null }, { email: 1 }, { email: true }])("requires an email string (%j)", (body) => {
    expect(() => parseOnboardingEmail(body)).toThrow("email string");
  });

  it.each(["", " ", "not-an-email", "a@@example.test", "@example.test", "a@", "a@localhost",
    "a..b@example.test", ".a@example.test", "a.@example.test", "a b@example.test",
    "a@-example.test", "a@example-.test", "a@example..test", "a@exam_ple.test",
    "<a>@example.test", "a@example.test\n", " a@example.test", "a@example.test ",
    `${"a".repeat(65)}@example.test`, `a@${"b".repeat(64)}.test`,
    `a@${Array<string>(5).fill("b".repeat(50)).join(".")}`])("rejects malformed email %j", (email) => {
    expect(() => parseOnboardingEmail({ email })).toThrow("valid email address");
  });

  it.each(["Person.Name+tag@gmail.com", "Other+Tag@EXAMPLE.TEST", "o'brien@example.test", "a@sub.example.test"])(
    "preserves spelling, dots, and tags in %s", (email) => {
      expect(parseOnboardingEmail({ email })).toBe(email);
    },
  );
});
