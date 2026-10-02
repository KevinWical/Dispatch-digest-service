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

## Onboarding HTTP API

Express implements the HTTP component specified in the architecture. It is the
only new runtime dependency for this workflow; TypeScript types are development-only.
`createApp` in `src/app.ts` handles HTTP parsing, validation, and response mapping.
`createOnboardingService` in `src/onboarding-service.ts` owns identity lookup and
credential selection. Unverified identities receive a verification request;
verified identities receive a management request. No email delivery is connected
yet. The service returns transient delivery material internally; the HTTP layer
discards it and never logs or returns credentials, hashes, identity IDs, or status.

Set the existing database environment variables and apply migrations. Also set
`VERIFICATION_TOKEN_TTL_SECONDS` to a positive whole number to choose the
verification lifetime explicitly. `PORT` is optional and defaults to 3000.
For example, a local `.env` may set `VERIFICATION_TOKEN_TTL_SECONDS=1800` for a
30-minute development lifetime; this is configuration, not a schema rule.
Then run `npm run build` and `npm start`. The API listens on `127.0.0.1` and
uses compiled JavaScript so NodeNext `.js` import specifiers resolve correctly.

`POST /onboarding` accepts an `application/json` object containing `email`, such
as `{ "email": "Person.Name+tag@example.com" }`. Conventional dot-atom email
addresses with a dotted domain are supported, with a 64-character local part
and 254-character total limit. Empty, malformed, nonstring, or surrounding-
whitespace input is rejected. No DNS lookup or provider-specific transformation
is performed: dots and `+tags` survive, and persistence lowercases defensively.
Malformed JSON/input returns 400, unsupported content type 415, and bodies over
8 KB return 413 without invoking the service. Successful valid requests always
return status 202 and `{ "message": "Check your inbox for the next step" }`,
regardless of identity existence or verification status. Persistence failures
return a generic 503 without sensitive error details. Responses use `no-store`.
The inbox message is the initial public contract; emails are not sent yet.

Tests exercise actual HTTP requests locally, plus both credential paths with
mocked persistence. The existing dedicated MySQL integration suite also checks
the HTTP-to-database workflow and runs in CI under its existing safety checks.

## User email identities

`findOrCreateUser(email)` in `src/user-persistence.ts` lowercases email before
lookup and persistence. It returns `{ id, email, isVerified }`, with the bigint
ID represented as a string. New users are unverified; existing users retain
their verification state. Concurrent inserts are resolved by the existing email
unique constraint, followed by reading the winning identity. The operation owns
and closes its connection. The onboarding boundary validates public input before
persistence; this result must not expose user existence in public responses.

## Verification tokens

`generateVerificationToken()` in `src/verification-token.ts` returns `rawToken`
and `tokenHash`. It uses Node's built-in `randomBytes` to generate 32 random bytes
(256 bits) and encodes them as a URL-safe base64 string. The hash is a SHA-256
hex digest of that exact string.

Use the raw token only to construct a future verification link; never persist
or log it. Persist only `tokenHash`. `hashVerificationToken(rawToken)` reproduces
the hash for future verification without trimming or normalizing the input.
This utility does not implement persistence, expiry, link handling, or delivery.

`replaceVerificationRequest(userId, expiresAt)` in `src/verification-persistence.ts`
creates a token before touching the database, then uses a dedicated connection
and transaction to lock the user, invalidate outstanding requests, and insert
the replacement hash. An insertion failure rolls back the invalidation. The
user lock serializes simultaneous replacements, including first requests.
Only the raw token string is returned after commit for constructing the link;
never log or persist it. The hash stays internal to the persistence operation.
Pass the bigint user ID as a string and an explicit future expiration Date.
This function does not decide verification eligibility or the token lifetime.

## Management credentials

`createManagementRequest(userId)` in `src/management-persistence.ts` generates
a cryptographically random, URL-safe 256-bit credential and inserts only its
SHA-256 hash into `management_requests`. A single autocommitted `INSERT ... SELECT`
requires the referenced user to be verified. The function returns only the raw
credential string after persistence succeeds; never persist or log it. The
bigint user ID is supplied as a string.

Creation and expiration use the same MySQL statement timestamp in UTC, with
the issuance function currently chooses expiration 30 minutes later. The database
only requires `expires_at > created_at`; it does not enforce a specific lifetime.
`consumed_at` starts NULL. Requests may
coexist; issuance does not consume or invalidate prior credentials. Management
credentials use a separate table and API from email verification. The table
has a restrictive user foreign key, unique token hash, and an index for a user's
unconsumed requests by expiry. Consumption, preference changes, and email/link
handling are not implemented.

The additive `003_management_requests` migration is applied using the existing
migration mechanism; earlier migration definitions are unchanged.

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
The tests apply migrations to that dedicated database, check constraints,
repeatability, replacement rollback, concurrent replacement, and concurrent
creation of a single lowercase user identity, and management credential issuance
with verified-user eligibility and exact expiration. Synthetic rows
are rolled back or removed by their test user ID; schema and migration history
remain for subsequent runs. They refuse the normal `DB_NAME` and any database
without the test prefix. Without this opt-in variable, live tests are skipped.
