import type { Connection } from "mysql2/promise";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectDatabase } from "../src/database.js";
import { findOrCreateUser } from "../src/user-persistence.js";

vi.mock("../src/database.js", () => ({ connectDatabase: vi.fn() }));

const row = { id: "9007199254740993", email: "user@example.test", is_verified: 0 };

function mockConnection() {
  const connection = {
    query: vi.fn().mockResolvedValue([[], []]),
    execute: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(connectDatabase).mockResolvedValue(connection as unknown as Connection);
  return connection;
}

describe("user email identity persistence", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([0, 1])("returns the existing identity and verified status %s without inserting", async (verified) => {
    const connection = mockConnection();
    connection.execute.mockResolvedValueOnce([[{ ...row, is_verified: verified }], []]);
    expect(await findOrCreateUser("USER@EXAMPLE.TEST")).toEqual({
      id: row.id, email: row.email, isVerified: verified === 1,
    });
    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute.mock.calls[0]?.[1]).toEqual([row.email]);
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("persists a lowercase email using the unverified schema default", async () => {
    const connection = mockConnection();
    connection.execute.mockResolvedValueOnce([[], []]).mockResolvedValueOnce([{}, []])
      .mockResolvedValueOnce([[row], []]);
    expect(await findOrCreateUser("User@Example.Test")).toEqual({
      id: row.id, email: row.email, isVerified: false,
    });
    expect(connection.execute.mock.calls[1]).toEqual(["INSERT INTO users (email) VALUES (?)", [row.email]]);
    expect(connection.execute.mock.calls[2]?.[1]).toEqual([row.email]);
  });

  it("reads the winning identity after a concurrent duplicate insert", async () => {
    const connection = mockConnection();
    const duplicate = Object.assign(new Error("Duplicate email"), { code: "ER_DUP_ENTRY" });
    connection.execute.mockResolvedValueOnce([[], []]).mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce([[{ ...row, is_verified: 1 }], []]);
    expect(await findOrCreateUser("USER@EXAMPLE.TEST")).toEqual({
      id: row.id, email: row.email, isVerified: true,
    });
    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("does not swallow unrelated insertion failures", async () => {
    const connection = mockConnection();
    const failure = Object.assign(new Error("Permission denied"), { code: "ER_TABLEACCESS_DENIED_ERROR" });
    connection.execute.mockResolvedValueOnce([[], []]).mockRejectedValueOnce(failure);
    await expect(findOrCreateUser(row.email)).rejects.toMatchObject({
      message: "Could not find or create the user email identity.", cause: failure,
    });
    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("reports lookup failures and closes the connection", async () => {
    const connection = mockConnection();
    connection.execute.mockRejectedValueOnce(new Error("Lookup failed"));
    await expect(findOrCreateUser(row.email)).rejects.toThrow("Could not find or create");
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it.each(["", "a".repeat(255)])("rejects empty or oversized email before database access", async (email) => {
    await expect(findOrCreateUser(email)).rejects.toThrow("User email must be nonempty");
    expect(connectDatabase).not.toHaveBeenCalled();
  });
});
