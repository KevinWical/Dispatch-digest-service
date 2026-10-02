import type { RowDataPacket } from "mysql2/promise";
import { connectDatabase } from "./database.js";
import { generateVerificationToken } from "./verification-token.js";

/** Return the link token only after its hash has been committed. Never log the result. */
export async function replaceVerificationRequest(
  userId: string,
  expiresAt: Date,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!/^[1-9]\d*$/.test(userId) || BigInt(userId) > 18446744073709551615n) {
    throw new Error("Verification request requires a valid unsigned bigint user ID.");
  }
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new Error("Verification request expiration must be a valid future date.");
  }
  // Randomness failure cannot affect an existing request: generate before any DB access.
  const token = generateVerificationToken();
  const expiration = expiresAt.toISOString().slice(0, 23).replace("T", " ");
  const connection = await connectDatabase(env);
  let transactionStarted = false;
  try {
    await connection.query("SET time_zone = '+00:00'");
    await connection.beginTransaction();
    transactionStarted = true;
    // Serialize replacements even when the user has no outstanding request yet.
    const [users] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE id = ? FOR UPDATE", [userId],
    );
    if (users.length === 0) {
      throw new Error("Cannot create verification request: the user does not exist.");
    }
    await connection.execute(
      "UPDATE verification_requests SET invalidated_at = CURRENT_TIMESTAMP(6) WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL",
      [userId],
    );
    await connection.execute(
      "INSERT INTO verification_requests (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
      [userId, token.tokenHash, expiration],
    );
    await connection.commit();
    transactionStarted = false;
    return token.rawToken;
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw new Error("Could not replace the verification request; the transaction did not complete.", { cause: error });
  } finally {
    await connection.end();
  }
}
