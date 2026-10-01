# Dispatch-digest-service
Dispatch is a hosted service for creating personalized, scheduled email digests from multiple sources, beginning with sports with the goal to add local and international news.

## Local development

Install dependencies with `npm ci` and run checks with `npm run validate`.
Checks use a mocked MySQL driver and do not require a running database.

To use database connectivity, provide a reachable MySQL server and an existing
database with an authorized user. Set `DB_HOST`, `DB_USER`, `DB_PASSWORD`, and
`DB_NAME` in the process environment; all four must be nonblank. `DB_PORT` is
optional and defaults to `3306` (valid range: 1–65535).

Copy `.env.example` to `.env` and fill in local settings if desired. The module
does not load `.env` automatically: export the variables in your shell or use
Node's `--env-file=.env` option when launching a TypeScript-capable runtime.
Local `.env` files are ignored by Git. Never commit real credentials.

Import `connectDatabase` from `src/database.ts` to establish a connection. It
reads settings at call time and returns the MySQL2 promise connection; callers
must `await connection.end()` when finished (use a `finally` block). Connection
failures reject the promise with the driver's error. Importing the module does
not open a connection. No tables or schema are created.
