import { describe, expect, it } from "vitest";
import { generateManagementCredential, hashManagementCredential } from "../src/management-credential.js";

describe("management credentials", () => {
  it("generates 256 bits of URL-safe link material and its SHA-256 persistence hash", () => {
    const { rawCredential, credentialHash } = generateManagementCredential();
    expect(rawCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(rawCredential, "base64url")).toHaveLength(32);
    expect(credentialHash).toMatch(/^[a-f0-9]{64}$/);
    expect(credentialHash).toBe(hashManagementCredential(rawCredential));
  });

  it("produces fresh credentials across successive requests", () => {
    const credentials = Array.from({ length: 64 }, () => generateManagementCredential());
    expect(new Set(credentials.map(({ rawCredential }) => rawCredential)).size).toBe(64);
    expect(new Set(credentials.map(({ credentialHash }) => credentialHash)).size).toBe(64);
  });

  it("hashes exact input deterministically", () => {
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(hashManagementCredential("abc")).toBe(expected);
    expect(hashManagementCredential("abc")).toBe(expected);
    expect(hashManagementCredential("ABC")).not.toBe(expected);
    expect(hashManagementCredential("abc ")).not.toBe(expected);
  });
});
