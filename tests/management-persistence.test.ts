import type { Connection } from "mysql2/promise";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectDatabase } from "../src/database.js";
import { generateManagementCredential } from "../src/management-credential.js";
import { createManagementRequest } from "../src/management-persistence.js";

vi.mock("../src/database.js", () => ({ connectDatabase: vi.fn() }));
vi.mock("../src/management-credential.js", () => ({ generateManagementCredential: vi.fn() }));

const credential = { rawCredential: "test-only-raw-credential", credentialHash: "a".repeat(64) };

function mockConnection() {
  const connection = {
    query: vi.fn().mockResolvedValue([[], []]),
    execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]),
    end: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(connectDatabase).mockResolvedValue(connection as unknown as Connection);
  return connection;
}

describe("management request persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateManagementCredential).mockReturnValue(credential);
  });

  it("returns only the raw credential after persisting its hash for a verified user", async () => {
    const connection = mockConnection();
    expect(await createManagementRequest("1")).toBe(credential.rawCredential);
    expect(connection.execute.mock.calls[0]?.[0]).toContain("verified_at IS NOT NULL");
    expect(connection.execute.mock.calls[0]?.[0]).toContain("INTERVAL 30 MINUTE");
    expect(connection.execute.mock.calls[0]?.[1]).toEqual([credential.credentialHash, "1"]);
    expect(JSON.stringify(connection.execute.mock.calls)).not.toContain(credential.rawCredential);
    expect(connection.execute).toHaveBeenCalledOnce();
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("does not release the credential while insertion is pending", async () => {
    const connection = mockConnection();
    let complete!: (value: unknown) => void;
    connection.execute.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    let returned = false;
    const pending = createManagementRequest("1").then((raw) => { returned = true; return raw; });
    await vi.waitFor(() => expect(connection.execute).toHaveBeenCalledOnce());
    expect(returned).toBe(false);
    complete([{ affectedRows: 1 }, []]);
    expect(await pending).toBe(credential.rawCredential);
  });

  it("rejects unknown or unverified users without returning a credential", async () => {
    const connection = mockConnection();
    connection.execute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    await expect(createManagementRequest("1")).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "Cannot issue a management credential: a verified user is required." }) as unknown,
    });
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("rejects persistence failure without returning the credential", async () => {
    const connection = mockConnection();
    connection.execute.mockRejectedValueOnce(new Error("Insert failed"));
    await expect(createManagementRequest("1")).rejects.toThrow("Could not create the management request");
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("does not touch the database if randomness fails", async () => {
    vi.mocked(generateManagementCredential).mockImplementationOnce(() => { throw new Error("Randomness unavailable"); });
    await expect(createManagementRequest("1")).rejects.toThrow("Randomness unavailable");
    expect(connectDatabase).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "invalid", "18446744073709551616"])("rejects invalid user ID %s before DB access", async (id) => {
    await expect(createManagementRequest(id)).rejects.toThrow("valid unsigned bigint user ID");
    expect(connectDatabase).not.toHaveBeenCalled();
  });
});
