import type { Connection } from "mysql2/promise";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectDatabase } from "../src/database.js";
import { generateVerificationToken } from "../src/verification-token.js";
import { replaceVerificationRequest } from "../src/verification-persistence.js";

vi.mock("../src/database.js", () => ({ connectDatabase: vi.fn() }));
vi.mock("../src/verification-token.js", () => ({ generateVerificationToken: vi.fn() }));

const token = { rawToken: "test-only-raw-token", tokenHash: "a".repeat(64) };
const expiry = new Date("2099-01-01T00:00:00.000Z");

function mockConnection() {
  const connection = {
    query: vi.fn().mockResolvedValue([[], []]),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue([[{ id: "1" }], []]),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(connectDatabase).mockResolvedValue(connection as unknown as Connection);
  return connection;
}

describe("atomic verification request replacement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateVerificationToken).mockReturnValue(token);
  });

  it("locks the user, invalidates, inserts only the hash, then commits", async () => {
    const connection = mockConnection();
    expect(await replaceVerificationRequest("1", expiry)).toBe(token.rawToken);
    expect(connection.execute.mock.calls[0]).toEqual(["SELECT id FROM users WHERE id = ? FOR UPDATE", ["1"]]);
    expect(connection.execute.mock.calls[1]?.[0]).toContain("UPDATE verification_requests");
    expect(connection.execute.mock.calls[2]).toEqual([
      "INSERT INTO verification_requests (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
      ["1", token.tokenHash, "2099-01-01 00:00:00.000"],
    ]);
    expect(connection.beginTransaction.mock.invocationCallOrder[0]!).toBeLessThan(connection.execute.mock.invocationCallOrder[0]!);
    expect(connection.execute.mock.invocationCallOrder[2]!).toBeLessThan(connection.commit.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(connection.execute.mock.calls)).not.toContain(token.rawToken);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("does not access the database when token generation fails", async () => {
    vi.mocked(generateVerificationToken).mockImplementation(() => { throw new Error("Randomness unavailable"); });
    await expect(replaceVerificationRequest("1", expiry)).rejects.toThrow("Randomness unavailable");
    expect(connectDatabase).not.toHaveBeenCalled();
  });

  it("rolls back invalidation when replacement insertion fails", async () => {
    const connection = mockConnection();
    connection.execute.mockResolvedValueOnce([[{ id: "1" }], []])
      .mockResolvedValueOnce([{}, []]).mockRejectedValueOnce(new Error("Insert failed"));
    await expect(replaceVerificationRequest("1", expiry)).rejects.toThrow("Could not replace");
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("does not invalidate requests for an unknown user", async () => {
    const connection = mockConnection();
    connection.execute.mockResolvedValueOnce([[], []]);
    await expect(replaceVerificationRequest("1", expiry)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "Cannot create verification request: the user does not exist." }) as unknown,
    });
    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it("rolls back when invalidation or commit fails", async () => {
    for (const failCommit of [false, true]) {
      const connection = mockConnection();
      if (failCommit) connection.commit.mockRejectedValueOnce(new Error("Commit failed"));
      else connection.execute.mockResolvedValueOnce([[{ id: "1" }], []]).mockRejectedValueOnce(new Error("Update failed"));
      await expect(replaceVerificationRequest("1", expiry)).rejects.toThrow("Could not replace");
      expect(connection.rollback).toHaveBeenCalledOnce();
      expect(connection.end).toHaveBeenCalledOnce();
    }
  });

  it("closes the connection if starting the transaction fails", async () => {
    const connection = mockConnection();
    connection.beginTransaction.mockRejectedValueOnce(new Error("Begin failed"));
    await expect(replaceVerificationRequest("1", expiry)).rejects.toThrow("Could not replace");
    expect(connection.execute).not.toHaveBeenCalled();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it.each(["0", "-1", "invalid", "18446744073709551616"])("rejects invalid user ID %s before DB access", async (id) => {
    await expect(replaceVerificationRequest(id, expiry)).rejects.toThrow("user ID");
    expect(connectDatabase).not.toHaveBeenCalled();
  });

  it.each([new Date(NaN), new Date(0)])("rejects invalid expiration before DB access", async (date) => {
    await expect(replaceVerificationRequest("1", date)).rejects.toThrow("future date");
    expect(connectDatabase).not.toHaveBeenCalled();
  });
});
