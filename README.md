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

## Verification tokens

`generateVerificationToken()` in `src/verification-token.ts` returns `rawToken`
and `tokenHash`. It uses Node's built-in `randomBytes` to generate 32 random bytes
(256 bits) and encodes them as a URL-safe base64 string. The hash is a SHA-256
hex digest of that exact string.

Use the raw token only to construct a future verification link; never persist
or log it. Persist only `tokenHash`. `hashVerificationToken(rawToken)` reproduces
the hash for future verification without trimming or normalizing the input.
This utility does not implement persistence, expiry, link handling, or delivery.

## Database migrations

Use Node.js 24 or newer (native TypeScript execution) and MySQL 8.0.16 or newer
(enforced CHECK constraints). Create the database first and set `DB_NAME` to it.
With the connection variables exported or configured in local `.env`, run:

```sh
npm run db:migrate
```

The command loads `.env` if present; exported environment variables take
precedence. The database user needs CREATE, SELECT, INSERT, UPDATE and REFERENCES
permissions for this initial schema. It does not create the database itself.
Running it again skips completed migrations. It uses a database-scoped advisory
lock to prevent concurrent runners, and records migration IDs, SQL checksums,
and start/completion times in `schema_migrations`. Validation tests mock MySQL
and never apply migrations to your configured database.

Add future migrations to the ordered list in `src/migrations.ts` with a new ID
and one SQL statement per migration. Never change a recorded migration; checksum
mismatches stop the runner. Migrations only move forward; no automatic rollback
or destructive reset command is provided. MySQL DDL implicitly commits. If a
run is interrupted, its incomplete record blocks further migrations: inspect
the schema before manually repairing that record. If the exact DDL completed,
mark it completed; if it did not, correct the underlying problem and remove
only the incomplete tracking record before retrying. Never drop persisted data
as a recovery shortcut. Existing unmanaged tables are not silently adopted.

`users` has an unsigned bigint identity, a unique email (case-insensitive,
accent-sensitive comparison), creation time, and nullable `verified_at`; NULL
means unverified. Application code must validate email input before persistence.
`verification_requests` references the user with restrictive deletion, stores
only a unique 64-character lowercase SHA-256 hash, and records creation, expiry,
use, and invalidation times. All DATETIME(6) values use a UTC convention; the
runner sets its session to UTC and future writers must do the same.

A unique generated column permits only one unused, non-invalidated request per
user. Expired requests still occupy this slot until invalidated; a future
request-creation transaction must invalidate outstanding requests before
inserting the newest one. The schema cannot determine which request is newest
or update earlier requests automatically. The `(user_id, created_at, id)` index
supports per-user history and newest-request lookup, and the unique hash index
supports token lookup. Checks enforce expiration after creation, use before
expiration, and mutually exclusive successful-use/invalidation states. Request
logic, verification expiry duration, subscriptions, and management credentials
are outside this migration.

For optional live schema tests, create a separate empty database named
`dispatch_test_<suffix>` and grant your test user the same migration permissions
plus DELETE. Export `DISPATCH_TEST_DB_NAME` with that name and provide the usual
`DB_HOST`, `DB_USER`, `DB_PASSWORD`, and `DB_PORT` settings. Run
`node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run tests/migrations.integration.test.ts`.
The test applies migrations to that dedicated database, checks constraints and
repeatability, and rolls back its synthetic rows; schema and migration history
remain for subsequent runs. It refuses the normal `DB_NAME` and any database
without the test prefix. Without this opt-in variable, live tests are skipped.
