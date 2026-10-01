import { createConnection } from "mysql2/promise";
import type { Connection, ConnectionOptions } from "mysql2/promise";

export function getDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): ConnectionOptions {
  const required = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"] as const;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required MySQL configuration: ${missing.join(", ")}. Set these environment variables before connecting.`,
    );
  }

  const portValue = env.DB_PORT ?? "3306";
  const port = Number(portValue);
  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid MySQL configuration: DB_PORT must be an integer between 1 and 65535.");
  }

  return {
    host: env.DB_HOST!,
    user: env.DB_USER!,
    password: env.DB_PASSWORD!,
    database: env.DB_NAME!,
    port,
  };
}

// The caller owns the connection and must await connection.end() when finished.
export async function connectDatabase(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Connection> {
  return createConnection(getDatabaseConfig(env));
}
