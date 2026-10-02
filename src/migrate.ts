import { connectDatabase } from "./database.js";
import { runMigrations } from "./migrations.js";

let connection;
try {
  connection = await connectDatabase();
  const applied = await runMigrations(connection);
  console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database migrations are up to date.");
} catch (error) {
  // Driver messages may contain connection details; print only safe codes.
  const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
  console.error(code ? `Database migration connection/setup failed (${code}). Check configuration and database permissions.` : error instanceof Error ? error.message : "Database migrations failed.");
  process.exitCode = 1;
} finally {
  if (connection) await connection.end();
}
