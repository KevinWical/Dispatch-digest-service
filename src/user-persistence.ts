import type { RowDataPacket } from "mysql2/promise";
import { connectDatabase } from "./database.js";

export interface UserIdentity {
  id: string;
  email: string;
  isVerified: boolean;
}

interface UserRow extends RowDataPacket {
  id: string;
  email: string;
  is_verified: number;
}

/** Find or create an email identity without changing an existing user's verification state. */
export async function findOrCreateUser(
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UserIdentity> {
  const canonicalEmail = email.toLowerCase();
  if (!canonicalEmail || canonicalEmail.length > 254) {
    throw new Error("User email must be nonempty and no longer than 254 characters.");
  }
  const connection = await connectDatabase(env);
  try {
    await connection.query("SET time_zone = '+00:00'");
    const find = async (): Promise<UserIdentity | undefined> => {
      const [rows] = await connection.execute<UserRow[]>(
        "SELECT CAST(id AS CHAR) AS id, email, (verified_at IS NOT NULL) AS is_verified FROM users WHERE email = ?",
        [canonicalEmail],
      );
      const row = rows[0];
      return row ? { id: row.id, email: row.email, isVerified: row.is_verified === 1 } : undefined;
    };
    const existing = await find();
    if (existing) return existing;

    try {
      // Defaults create an unverified user; the unique index arbitrates concurrent inserts.
      await connection.execute("INSERT INTO users (email) VALUES (?)", [canonicalEmail]);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ER_DUP_ENTRY")) throw error;
      // Another connection won the race. Read its committed identity using autocommit.
    }
    const user = await find();
    if (!user) throw new Error("The user identity was not found after creation or a concurrent insert.");
    return user;
  } catch (error) {
    throw new Error("Could not find or create the user email identity.", { cause: error });
  } finally {
    await connection.end();
  }
}
