import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { expect, it, vi } from "vitest";
import { connectDatabase } from "../src/database.js";
import { runMigrations } from "../src/migrations.js";
import { replaceVerificationRequest } from "../src/verification-persistence.js";
import * as tokenModule from "../src/verification-token.js";

const database = process.env.DISPATCH_TEST_DB_NAME;

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
