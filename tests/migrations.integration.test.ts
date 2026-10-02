import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { expect, it, vi } from "vitest";
import { connectDatabase } from "../src/database.js";
import { runMigrations } from "../src/migrations.js";
import { replaceVerificationRequest } from "../src/verification-persistence.js";
import * as tokenModule from "../src/verification-token.js";
import { findOrCreateUser } from "../src/user-persistence.js";
import { createManagementRequest } from "../src/management-persistence.js";
import { hashManagementCredential } from "../src/management-credential.js";
import { createOnboardingService } from "../src/onboarding-service.js";
import { withOnboardingServer } from "./http-helper.js";

const database = process.env.DISPATCH_TEST_DB_NAME;

interface ManagementRequestRow extends RowDataPacket {
  token_hash: string;
  consumed_at: Date | null;
  lifetime?: number;
}

it.skipIf(!database)("enforces the migrated schema in a dedicated MySQL test database", async () => {
  if (!database?.startsWith("dispatch_test_") || database === process.env.DB_NAME) {
    throw new Error("DISPATCH_TEST_DB_NAME must name a separate database beginning with dispatch_test_.");
  }
  const connection = await connectDatabase({ ...process.env, DB_NAME: database });
  try {
    await runMigrations(connection);
    expect(await runMigrations(connection)).toEqual([]);
    await connection.beginTransaction();
    const email = `${randomUUID()}@example.test`;
    const [user] = await connection.execute<ResultSetHeader>(
      "INSERT INTO users (email) VALUES (?)", [email],
    );
    await expect(connection.execute("INSERT INTO users (email) VALUES (?)", [email.toUpperCase()]))
      .rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    const insertRequest = (userId: number, hash: string, expiry = "2026-01-02 00:00:00") =>
      connection.execute<ResultSetHeader>(
        "INSERT INTO verification_requests (user_id, token_hash, created_at, expires_at) VALUES (?, ?, '2026-01-01 00:00:00', ?)",
        [userId, hash, expiry],
      );
    const [request] = await insertRequest(user.insertId, "a".repeat(64));
    await expect(insertRequest(user.insertId, "b".repeat(64))).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    await expect(connection.execute("DELETE FROM users WHERE id = ?", [user.insertId]))
      .rejects.toMatchObject({ code: "ER_ROW_IS_REFERENCED_2" });
    await connection.execute("UPDATE verification_requests SET invalidated_at = '2026-01-01 01:00:00' WHERE id = ?", [request.insertId]);
    await expect(insertRequest(user.insertId, "a".repeat(64))).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    await expect(insertRequest(user.insertId, "b".repeat(64), "2025-12-31 00:00:00"))
      .rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(insertRequest(user.insertId, "raw-token"))
      .rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    const [next] = await insertRequest(user.insertId, "b".repeat(64));
    await expect(connection.execute("UPDATE verification_requests SET used_at = expires_at WHERE id = ?", [next.insertId]))
      .rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await connection.execute("UPDATE verification_requests SET used_at = '2026-01-01 02:00:00' WHERE id = ?", [next.insertId]);
    await expect(connection.execute("UPDATE verification_requests SET invalidated_at = '2026-01-01 03:00:00' WHERE id = ?", [next.insertId]))
      .rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await connection.execute("UPDATE users SET verified_at = '2026-01-01 02:00:00' WHERE id = ?", [user.insertId]);
    const [other] = await connection.execute<ResultSetHeader>("INSERT INTO users (email) VALUES (?)", [`${randomUUID()}@example.test`]);
    await connection.execute("DELETE FROM users WHERE id = ?", [other.insertId]);
    await expect(insertRequest(other.insertId, "c".repeat(64)))
      .rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
  } finally {
    try {
      await connection.rollback();
    } finally {
      await connection.end();
    }
  }
});

it.skipIf(!database)("onboards through HTTP with real MySQL while keeping every valid identity response identical", async () => {
  if (!database?.startsWith("dispatch_test_") || database === process.env.DB_NAME) {
    throw new Error("DISPATCH_TEST_DB_NAME must name a separate database beginning with dispatch_test_.");
  }
  const env = { ...process.env, DB_NAME: database };
  const connection = await connectDatabase(env);
  const email = `${randomUUID()}.name+tag@example.test`;
  let userId: string | undefined;
  try {
    await runMigrations(connection);
    await withOnboardingServer(createOnboardingService(60_000, env), async (url) => {
      const submit = async () => {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.toUpperCase() }) });
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ message: "Check your inbox for the next step" });
      };
      await submit();
      const [users] = await connection.execute<(RowDataPacket & { id: string; email: string; verified_at: Date | null })[]>(
        "SELECT CAST(id AS CHAR) AS id, email, verified_at FROM users WHERE email = ?", [email],
      );
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ email, verified_at: null });
      userId = users[0]!.id;
      const [first] = await connection.execute<RowDataPacket[]>(
        "SELECT token_hash, invalidated_at, used_at FROM verification_requests WHERE user_id = ?", [userId],
      );
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ invalidated_at: null, used_at: null });
      expect(first[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
      await submit();
      const [repeated] = await connection.execute<RowDataPacket[]>(
        "SELECT COUNT(*) AS total, SUM(invalidated_at IS NULL AND used_at IS NULL) AS outstanding FROM verification_requests WHERE user_id = ?", [userId],
      );
      expect(repeated[0]).toMatchObject({ total: 2 });
      // SUM is returned as a decimal string by MySQL2.
      expect(Number(repeated[0]?.outstanding)).toBe(1);
      await connection.execute("UPDATE users SET verified_at = CURRENT_TIMESTAMP(6) WHERE id = ?", [userId]);
      await submit();
      const [management] = await connection.execute<ManagementRequestRow[]>(
        "SELECT token_hash, consumed_at FROM management_requests WHERE user_id = ?", [userId],
      );
      expect(management).toHaveLength(1);
      expect(management[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(management[0]?.consumed_at).toBeNull();
      const [verification] = await connection.execute<RowDataPacket[]>(
        "SELECT COUNT(*) AS total FROM verification_requests WHERE user_id = ?", [userId],
      );
      expect(verification[0]).toMatchObject({ total: 2 });
      const invalid = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "malformed" }) });
      expect(invalid.status).toBe(400);
    });
  } finally {
    try {
      // Scope cleanup to the unique synthetic identity created by this test.
      const [users] = await connection.execute<(RowDataPacket & { id: string })[]>(
        "SELECT CAST(id AS CHAR) AS id FROM users WHERE email = ?", [email],
      );
      userId = users[0]?.id;
      if (userId) {
        await connection.execute("DELETE FROM management_requests WHERE user_id = ?", [userId]);
        await connection.execute("DELETE FROM verification_requests WHERE user_id = ?", [userId]);
        await connection.execute("DELETE FROM users WHERE id = ?", [userId]);
      }
    } finally {
      await connection.end();
    }
  }
});

it.skipIf(!database)("persists independent 30-minute management credentials only for verified users", async () => {
  if (!database?.startsWith("dispatch_test_") || database === process.env.DB_NAME) {
    throw new Error("DISPATCH_TEST_DB_NAME must name a separate database beginning with dispatch_test_.");
  }
  const env = { ...process.env, DB_NAME: database };
  const connection = await connectDatabase(env);
  let userId: string | undefined;
  try {
    await runMigrations(connection);
    const [user] = await connection.execute<ResultSetHeader>(
      "INSERT INTO users (email) VALUES (?)", [`${randomUUID()}@example.test`],
    );
    userId = String(user.insertId);
    await expect(createManagementRequest(userId, env)).rejects.toThrow("Could not create");
    const [before] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM management_requests WHERE user_id = ?", [userId],
    );
    expect(before).toHaveLength(0);
    await connection.execute("UPDATE users SET verified_at = CURRENT_TIMESTAMP(6) WHERE id = ?", [userId]);
    const raw = await createManagementRequest(userId, env);
    const hash = hashManagementCredential(raw);
    const [requests] = await connection.execute<ManagementRequestRow[]>(
      "SELECT token_hash, consumed_at, TIMESTAMPDIFF(MICROSECOND, created_at, expires_at) AS lifetime FROM management_requests WHERE user_id = ?",
      [userId],
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ token_hash: hash, consumed_at: null, lifetime: 1_800_000_000 });
    expect(requests[0]?.token_hash).not.toBe(raw);
    await expect(connection.execute(
      "INSERT INTO management_requests (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 30 MINUTE))",
      [userId, hash],
    )).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    await connection.execute(
      "INSERT INTO management_requests (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 31 MINUTE))",
      [userId, "a".repeat(64)],
    );
    for (const expiresAt of ["2026-01-01 00:00:00", "2025-12-31 23:59:59"]) {
      await expect(connection.execute(
        "INSERT INTO management_requests (user_id, token_hash, created_at, expires_at) VALUES (?, ?, '2026-01-01 00:00:00', ?)",
        [userId, "b".repeat(64), expiresAt],
      )).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    }
    const concurrent = await Promise.allSettled(Array.from({ length: 3 }, () => createManagementRequest(userId!, env)));
    expect(concurrent.every(({ status }) => status === "fulfilled")).toBe(true);
    const [outstanding] = await connection.execute<ManagementRequestRow[]>(
      "SELECT token_hash, consumed_at FROM management_requests WHERE user_id = ?", [userId],
    );
    expect(outstanding).toHaveLength(5);
    expect(new Set(outstanding.map((row) => row.token_hash)).size).toBe(5);
    expect(outstanding.every((row) => row.consumed_at === null)).toBe(true);
    await connection.execute("UPDATE users SET verified_at = NULL WHERE id = ?", [userId]);
    await expect(createManagementRequest(userId, env)).rejects.toThrow("Could not create");
  } finally {
    try {
      if (userId) {
        await connection.execute("DELETE FROM management_requests WHERE user_id = ?", [userId]);
        await connection.execute("DELETE FROM users WHERE id = ?", [userId]);
      }
    } finally {
      await connection.end();
    }
  }
});

it.skipIf(!database)("finds or creates one lowercase email identity across concurrent MySQL connections", async () => {
  if (!database?.startsWith("dispatch_test_") || database === process.env.DB_NAME) {
    throw new Error("DISPATCH_TEST_DB_NAME must name a separate database beginning with dispatch_test_.");
  }
  const env = { ...process.env, DB_NAME: database };
  const connection = await connectDatabase(env);
  const email = `${randomUUID()}@example.test`;
  try {
    await runMigrations(connection);
    // Each operation opens its own connection; all race on the same unique email.
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
      findOrCreateUser(index % 2 ? email.toUpperCase() : email, env),
    ));
    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
    const identities = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(new Set(identities.map(({ id }) => id)).size).toBe(1);
    expect(identities.every((identity) => identity.email === email && !identity.isVerified)).toBe(true);
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT CAST(id AS CHAR) AS id, email, verified_at FROM users WHERE email = ?", [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: identities[0]?.id, email, verified_at: null });
    await expect(connection.execute("INSERT INTO users (email) VALUES (?)", [email.toUpperCase()]))
      .rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    await connection.execute("UPDATE users SET verified_at = CURRENT_TIMESTAMP(6) WHERE email = ?", [email]);
    expect(await findOrCreateUser(email.toUpperCase(), env)).toEqual({
      id: identities[0]?.id, email, isVerified: true,
    });
  } finally {
    try {
      await connection.execute("DELETE FROM users WHERE email = ?", [email]);
    } finally {
      await connection.end();
    }
  }
});

it.skipIf(!database)("replaces verification requests atomically and serializes concurrent replacements", async () => {
  if (!database?.startsWith("dispatch_test_") || database === process.env.DB_NAME) {
    throw new Error("DISPATCH_TEST_DB_NAME must name a separate database beginning with dispatch_test_.");
  }
  const env = { ...process.env, DB_NAME: database };
  const connection = await connectDatabase(env);
  let userId: string | undefined;
  try {
    await runMigrations(connection);
    const [user] = await connection.execute<ResultSetHeader>(
      "INSERT INTO users (email) VALUES (?)", [`${randomUUID()}@example.test`],
    );
    userId = String(user.insertId);
    const expiry = new Date(Date.now() + 60_000);
    const original = await replaceVerificationRequest(userId, expiry, env);
    const originalHash = tokenModule.hashVerificationToken(original);
    // Force a unique-hash violation after invalidation; the original must survive.
    vi.spyOn(tokenModule, "generateVerificationToken").mockReturnValueOnce({
      rawToken: "synthetic-failed-token", tokenHash: originalHash,
    });
    await expect(replaceVerificationRequest(userId, expiry, env)).rejects.toThrow("Could not replace");
    vi.restoreAllMocks();
    const [afterFailure] = await connection.execute<RowDataPacket[]>(
      "SELECT token_hash, invalidated_at, used_at FROM verification_requests WHERE user_id = ?", [userId],
    );
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]).toMatchObject({ token_hash: originalHash, invalidated_at: null, used_at: null });

    const replacements = await Promise.all([
      replaceVerificationRequest(userId, expiry, env),
      replaceVerificationRequest(userId, expiry, env),
    ]);
    const [requests] = await connection.execute<RowDataPacket[]>(
      "SELECT token_hash, invalidated_at FROM verification_requests WHERE user_id = ? ORDER BY id", [userId],
    );
    expect(requests).toHaveLength(3);
    expect(requests.filter((row) => row.invalidated_at === null)).toHaveLength(1);
    expect(requests[0]?.invalidated_at).not.toBeNull();
    expect(requests[1]?.invalidated_at).not.toBeNull();
    expect(requests[2]?.invalidated_at).toBeNull();
    expect(replacements.map(tokenModule.hashVerificationToken)).toContain(requests[2]?.token_hash);
  } finally {
    vi.restoreAllMocks();
    try {
      // Remove only this test's synthetic rows from its dedicated test database.
      if (userId) {
        await connection.execute("DELETE FROM verification_requests WHERE user_id = ?", [userId]);
        await connection.execute("DELETE FROM users WHERE id = ?", [userId]);
      }
    } finally {
      await connection.end();
    }
  }
});
