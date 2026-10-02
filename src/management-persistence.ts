import type { ResultSetHeader } from "mysql2/promise";
import { connectDatabase } from "./database.js";
import { generateManagementCredential } from "./management-credential.js";

/** Issue a 30-minute credential for a verified user. Never persist or log the result. */
export async function createManagementRequest(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!/^[1-9]\d*$/.test(userId) || BigInt(userId) > 18446744073709551615n) {
    throw new Error("Management request requires a valid unsigned bigint user ID.");
  }
  const credential = generateManagementCredential();
  const connection = await connectDatabase(env);
  try {
    await connection.query("SET time_zone = '+00:00', autocommit = 1");
    // A single autocommitted statement checks eligibility and persists the request.
    // MySQL's current timestamp is stable within the statement, so expiry is exact.
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO management_requests (user_id, token_hash, created_at, expires_at)
       SELECT id, ?, CURRENT_TIMESTAMP(6), DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 30 MINUTE)
       FROM users WHERE id = ? AND verified_at IS NOT NULL`,
      [credential.credentialHash, userId],
    );
    if (result.affectedRows !== 1) {
      throw new Error("Cannot issue a management credential: a verified user is required.");
    }
    return credential.rawCredential;
  } catch (error) {
    throw new Error("Could not create the management request.", { cause: error });
  } finally {
    await connection.end();
  }
}
