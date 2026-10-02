import { describe, expect, it } from "vitest";
import {
  generateVerificationToken,
  hashVerificationToken,
} from "../src/verification-token.js";

describe("verification tokens", () => {
  it("generates a URL-safe token containing 32 bytes and its persistence hash", () => {
    const { rawToken, tokenHash } = generateVerificationToken();

    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(rawToken, "base64url")).toHaveLength(32);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).toBe(hashVerificationToken(rawToken));
    expect(tokenHash).not.toBe(rawToken);
  });

  it("produces fresh tokens and hashes across successive calls", () => {
    const tokens = Array.from({ length: 64 }, () => generateVerificationToken());

    expect(new Set(tokens.map(({ rawToken }) => rawToken)).size).toBe(64);
    expect(new Set(tokens.map(({ tokenHash }) => tokenHash)).size).toBe(64);
  });

  it("matches the known SHA-256 digest for an exact input", () => {
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(hashVerificationToken("abc")).toBe(expected);
    expect(hashVerificationToken("abc")).toBe(expected);
  });

  it("hashes the exact string, including case and whitespace", () => {
    const original = hashVerificationToken("abc");

    for (const changed of ["Abc", "abc ", " abc", "abcd"]) {
      expect(hashVerificationToken(changed)).not.toBe(original);
    }
  });
});
