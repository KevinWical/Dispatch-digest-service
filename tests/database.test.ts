import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "mysql2/promise";
import { connectDatabase, getDatabaseConfig } from "../src/database.js";

vi.mock("mysql2/promise", () => ({ createConnection: vi.fn() }));

const env = {
  DB_HOST: "localhost",
  DB_USER: "test-user",
  DB_PASSWORD: "test-only-password",
  DB_NAME: "test-database",
};

describe("MySQL connectivity", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reads required settings and defaults to port 3306", () => {
    expect(getDatabaseConfig(env)).toEqual({
      host: env.DB_HOST,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      port: 3306,
    });
  });

  it("reads a custom port and preserves password whitespace", () => {
    expect(getDatabaseConfig({ ...env, DB_PORT: "3307", DB_PASSWORD: " secret " }))
      .toMatchObject({ port: 3307, password: " secret " });
  });

  it("lists missing settings before attempting a connection", async () => {
    await expect(connectDatabase({})).rejects.toThrow(
      "Missing required MySQL configuration: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME",
    );
    expect(createConnection).not.toHaveBeenCalled();
  });

  it.each(["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"])(
    "rejects blank %s without disclosing credentials",
    (key) => {
      expect(() => getDatabaseConfig({ ...env, [key]: "  " })).toThrow(key);
      expect(() => getDatabaseConfig({ ...env, [key]: "" })).toThrow(key);
    },
  );

  it.each(["", "0", "65536", "3.5", "invalid", "3306junk", " 3306 "])(
    "rejects invalid port %j before connecting",
    async (DB_PORT) => {
      await expect(connectDatabase({ ...env, DB_PORT })).rejects.toThrow(
        "DB_PORT must be an integer between 1 and 65535",
      );
      expect(createConnection).not.toHaveBeenCalled();
    },
  );

  it("returns the established connection to the caller", async () => {
    const connection = { end: vi.fn() };
    vi.mocked(createConnection).mockResolvedValue(connection as unknown as Awaited<ReturnType<typeof createConnection>>);
    expect(await connectDatabase(env)).toBe(connection);
    expect(createConnection).toHaveBeenCalledExactlyOnceWith(getDatabaseConfig(env));
  });

  it("propagates connection failures", async () => {
    const failure = new Error("connect ECONNREFUSED");
    vi.mocked(createConnection).mockRejectedValue(failure);
    await expect(connectDatabase(env)).rejects.toBe(failure);
  });

  it("uses process environment by default", () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv("DB_PORT", "3308");
    try {
      expect(getDatabaseConfig()).toMatchObject({ port: 3308, host: "localhost" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
