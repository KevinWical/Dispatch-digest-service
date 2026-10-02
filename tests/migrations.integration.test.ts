import { randomUUID } from "node:crypto";
import type { ResultSetHeader } from "mysql2/promise";
import { expect, it } from "vitest";
import { connectDatabase } from "../src/database.js";
import { runMigrations } from "../src/migrations.js";

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
