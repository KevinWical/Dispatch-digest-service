import { createHash } from "node:crypto";
import type { Connection, RowDataPacket } from "mysql2/promise";

export const migrations = [
  {
    id: "001_users",
    sql: `CREATE TABLE users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(254) COLLATE utf8mb4_0900_as_ci NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      verified_at DATETIME(6) NULL,
      CONSTRAINT uq_users_email UNIQUE (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci`,
  },
  {
    id: "002_verification_requests",
    sql: `CREATE TABLE verification_requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      expires_at DATETIME(6) NOT NULL,
      used_at DATETIME(6) NULL,
      invalidated_at DATETIME(6) NULL,
      outstanding_user_id BIGINT UNSIGNED GENERATED ALWAYS AS
        (CASE WHEN used_at IS NULL AND invalidated_at IS NULL THEN user_id ELSE NULL END) STORED,
      CONSTRAINT fk_verification_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT uq_verification_hash UNIQUE (token_hash),
      CONSTRAINT uq_verification_outstanding UNIQUE (outstanding_user_id),
      INDEX ix_verification_user_created (user_id, created_at, id),
      CONSTRAINT ck_verification_expiry CHECK (expires_at > created_at),
      CONSTRAINT ck_verification_used CHECK (used_at IS NULL OR (used_at >= created_at AND used_at < expires_at)),
      CONSTRAINT ck_verification_invalidated CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
      CONSTRAINT ck_verification_terminal CHECK (used_at IS NULL OR invalidated_at IS NULL),
      CONSTRAINT ck_verification_hash CHECK (REGEXP_LIKE(token_hash, '^[0-9a-f]{64}$', 'c'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci`,
  },
  {
    id: "003_management_requests",
    sql: `CREATE TABLE management_requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      expires_at DATETIME(6) NOT NULL,
      consumed_at DATETIME(6) NULL,
      CONSTRAINT fk_management_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT uq_management_hash UNIQUE (token_hash),
      INDEX ix_management_user_expiry (user_id, consumed_at, expires_at),
      CONSTRAINT ck_management_expiry CHECK (expires_at > created_at),
      CONSTRAINT ck_management_hash CHECK (REGEXP_LIKE(token_hash, '^[0-9a-f]{64}$', 'c'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci`,
  },
] as const;

interface MigrationRow extends RowDataPacket {
  id: string;
  checksum: string;
  completed_at: unknown;
}

/** Uses a dedicated connection; callers close it even when a migration fails. */
export async function runMigrations(connection: Connection): Promise<string[]> {
  const [locks] = await connection.query<RowDataPacket[]>(
    "SELECT GET_LOCK(CONCAT('dispatch-migrate:', LEFT(SHA2(DATABASE(), 256), 40)), 0) AS acquired",
  );
  if (locks[0]?.acquired !== 1) {
    throw new Error("Cannot apply migrations: another migration runner holds the database lock.");
  }

  try {
    await connection.query("SET time_zone = '+00:00'");
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      completed_at DATETIME(6) NULL
    ) ENGINE=InnoDB`);
    const [rows] = await connection.query<MigrationRow[]>(
      "SELECT id, checksum, completed_at FROM schema_migrations ORDER BY id",
    );
    // Validate all recorded history before making any schema changes.
    for (const row of rows) {
      const migration = migrations.find(({ id }) => id === row.id);
      if (!migration || createHash("sha256").update(migration.sql).digest("hex") !== row.checksum) {
        throw new Error(`Migration history mismatch for ${row.id}. Restore the original migration before proceeding.`);
      }
      if (row.completed_at === null) {
        throw new Error(`Migration ${row.id} is incomplete. Inspect the schema and repair the migration record before retrying; MySQL DDL cannot be rolled back.`);
      }
    }

    const applied: string[] = [];
    for (const migration of migrations) {
      if (rows.some(({ id }) => id === migration.id)) continue;
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      await connection.execute("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)", [migration.id, checksum]);
      try {
        await connection.query(migration.sql);
        await connection.execute("UPDATE schema_migrations SET completed_at = CURRENT_TIMESTAMP(6) WHERE id = ?", [migration.id]);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? ` (${String(error.code)})` : "";
        throw new Error(`Migration ${migration.id} failed${code}. Its record remains incomplete; inspect the schema and database permissions before repairing and retrying.`, { cause: error });
      }
      applied.push(migration.id);
    }
    return applied;
  } finally {
    await connection.query("SELECT RELEASE_LOCK(CONCAT('dispatch-migrate:', LEFT(SHA2(DATABASE(), 256), 40)))");
  }
}
