# Deployment

How the three deployment profiles differ, what to configure, and how background jobs are driven. The normative boundary is [architecture/deployment-and-risks.md § Deployment](architecture/deployment-and-risks.md#deployment) and [architecture/persistence.md § Persistence](architecture/persistence.md#persistence); this document is the operational companion.

The Cloudflare Workers profile can be published from a GitHub Release with [`create-signkit`](create-signkit.md) (`npx create-signkit --cloudflare ...`). That deployment CLI is not the Rust API CLI documented in [cli.md](cli.md).

## Profiles

`DEPLOY_TARGET` selects the adapter at build time. Each target produces its own artifact; there is no universal runtime build.

| Target             | Build                       | Database      | Objects                 | Background work                      | Status               |
| ------------------ | --------------------------- | ------------- | ----------------------- | ------------------------------------ | -------------------- |
| Node/Docker        | `pnpm run build:node`       | PostgreSQL 18 | S3-compatible           | host scheduler posts to drain routes | scaffolded           |
| Cloudflare Workers | `pnpm run build:cloudflare` | D1 binding    | R2 binding              | one-minute cron drains in-process    | scaffolded           |
| Vercel             | `pnpm run build:vercel`     | PostgreSQL    | S3-compatible initially | platform-specific, not yet specified | low-priority backlog |

Priority order is Node/Docker first, Cloudflare second, Vercel last. Vercel compiles in CI but is not supported for production use.

## Node / Docker

PostgreSQL 18 is the database baseline for this profile: CI validates against `postgres:18-alpine`, and that is the version new deployments should run. The migrations in `migrations/postgres` do not depend on version-18-only features, but older servers are not exercised by the test suite.

The supplied multi-stage `Dockerfile` builds the Node profile and runs it as the non-root `signkit` user on port 3000. Its healthcheck polls `GET /api/v1/system/capabilities`, an unauthenticated read that reports the API version, the detected runtime, and the supported profiles.

### Applying PostgreSQL migrations

`scripts/postgres-migrate.mjs` (`pnpm run db:migrate:postgres`) is the migration runner for this profile. It applies every file in `migrations/postgres` in filename order, each inside its own transaction, and records a durable `schema_migrations` ledger row (filename plus a SHA-256 checksum of that file's contents) only once that migration's transaction commits. A session-level `pg_advisory_lock` held for the whole run means a second concurrent invocation against the same database blocks instead of racing DDL. If an already-applied file's contents ever change on disk, the recorded checksum no longer matches it, and the runner refuses to proceed — reapplying an edited migration or silently ignoring the mismatch would both be worse than stopping and asking an operator to look. It supports a fresh, empty PostgreSQL 18 database (applies everything) and an already-current one (reports up to date and does nothing) the same way. `pnpm run db:migrate:postgres:check` (`--check`) reports pending migrations and checksum drift without ever writing to the database — safe to run with a read-only role as a release or deploy gate. Diagnostics are always filenames, checksums, and counts; the connection string and any credential are never logged.

**Run the migrator separately from the long-lived app process, with a different, more privileged database role.** The app's own `DATABASE_URL` should point at a role that can only read and write ordinary rows (`SELECT`/`INSERT`/`UPDATE`/`DELETE` on the application tables) — it never needs to create or alter a table while serving requests, so it should not be able to. The migrator needs `CREATE`/`ALTER`/`DROP` (schema DDL) plus read/write on `schema_migrations`; grant that to a separate role used only for this one-off invocation, for example:

```sql
-- One-time setup, run by an administrative role:
CREATE ROLE signkit_migrator LOGIN PASSWORD '...';
CREATE ROLE signkit_app LOGIN PASSWORD '...';
GRANT CREATE ON DATABASE signkit TO signkit_migrator;
GRANT ALL PRIVILEGES ON SCHEMA public TO signkit_migrator;
-- After the first `db:migrate:postgres` run has created the application tables:
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO signkit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE signkit_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO signkit_app;
```

The same Docker image serves both roles without any extra build: the app container's `CMD` is unchanged (`node build/node/index.js`, using `signkit_app`'s `DATABASE_URL`), while a migration is a short-lived, separate invocation of the same image with a different command and the `signkit_migrator` connection string, run once before rolling out a version that depends on new migrations and then discarded:

```sh
docker run --rm -e DATABASE_URL="postgres://signkit_migrator:...@host/signkit" \
  <image> node scripts/postgres-migrate.mjs
```

Never set the app's long-lived `DATABASE_URL` to the migrator role — that would hand DDL rights to a process that accepts external requests, defeating the point of separating them.

Put the app behind a reverse proxy that preserves the public HTTPS origin: `SIGNKIT_PUBLIC_ORIGIN` must match both the d6e-auth `/auth/callback` redirect URI registered for the client and the origin used to mint recipient signing and completion links.

Objects go to any S3-compatible service. Most of them require path-style addressing (`S3_FORCE_PATH_STYLE=true`); set it to `false` for AWS S3 itself. R2 is not used through its S3 endpoint on this profile.

### Mail

`SIGNKIT_MAIL_PROVIDER` selects the transport for invitation and completion delivery and accepts exactly two values:

- `smtp` — a production Nodemailer SMTP client configured by `SIGNKIT_SMTP_HOST`, `SIGNKIT_SMTP_PORT`, `SIGNKIT_SMTP_SECURE`, and the optional `SIGNKIT_SMTP_USERNAME`/`SIGNKIT_SMTP_PASSWORD` pair. `SIGNKIT_SMTP_SECURE` is required and must be exactly `true` or `false` — there is no default, so an unset or blank value fails closed. `true` opens the connection already inside TLS (implicit TLS, typically port 465); `false` connects in the clear and then requires a STARTTLS upgrade before any mail command, aborting the send if the server cannot upgrade. There is no configuration that permits a plaintext session. Username and password must be set together or not at all — one without the other fails closed; the password is never trimmed, so its exact bytes reach the server. **Resend and any other SMTP-speaking provider are configured this way, through their ordinary SMTP endpoint and credentials; SignKit has no Resend-specific code.**
- `cloudflare` — Cloudflare Email Sending, called through the REST API on Node/Docker and Vercel with `CLOUDFLARE_EMAIL_ACCOUNT_ID`/`CLOUDFLARE_EMAIL_API_TOKEN` (this profile), or through the native `EMAIL` binding on Cloudflare Workers (see below).

An unset, misspelled, or runtime-incompatible provider, or an incomplete provider configuration, makes the delivery and completion-delivery services unavailable (fail closed) rather than guessing a transport.

## Cloudflare Workers

`wrangler.jsonc` declares the `DB` (D1), `OBJECTS` (R2), `ASSETS`, and `EMAIL` bindings, `nodejs_compat`, a `SIGNKIT_MAIL_PROVIDER=cloudflare` var, observability, and a `* * * * *` cron trigger. R2 is used through its in-process binding rather than an S3 endpoint, and D1 migrations live in `migrations/d1`.

The scheduled trigger invokes every protected drain and sweep in-process through the Worker's own `fetch` handler — invitation delivery, completion-artifact publication, completion delivery, envelope expiry, webhooks, both reseal sweeps, and orphan object collection — each via `context.waitUntil` so one failure cannot block the others. No external scheduler is required. Secrets belong in Wrangler secret storage (`.dev.vars` locally) and must never be committed: at minimum `DELIVERY_ENCRYPTION_KEY`, `SESSION_ENCRYPTION_KEY`, `DELIVERY_WORKER_SECRET`, the d6e-auth client credentials, plus the `SIGNKIT_PUBLIC_ORIGIN`, `SIGNKIT_EMAIL_FROM`, and `SIGNKIT_EMAIL_FROM_NAME` variables. `SIGNKIT_MAIL_PROVIDER` is not a secret — it already ships as a plain `vars` entry in `wrangler.jsonc`/`wrangler.build.jsonc` and does not need to be set separately per deployment.

SignKit intentionally supports only the native `EMAIL` binding on this profile and does not bundle or support a Worker SMTP client, so `SIGNKIT_MAIL_PROVIDER` must stay `cloudflare` here; any other value (including `smtp`) makes delivery and completion delivery fail closed rather than silently falling back. Cloudflare Email Sending is currently beta. Sending to arbitrary recipient addresses requires Workers Paid; free accounts can only send to verified destination addresses, which is fine for testing but not for real envelopes. Check the current [Email Sending pricing and availability](https://developers.cloudflare.com/email-service/platform/pricing/) before treating this profile as zero-cost.

## Vercel

The Vercel target builds with `adapter-vercel` on `nodejs22.x` and uses the same PostgreSQL and S3-compatible adapters as the Node profile. Native Vercel Blob is not S3-compatible and would need a separate adapter. Treat this profile as CI-validated only.

## Configuration

All values come from `.env.example`; copy it to `.env` for Node development, and set the same names as Worker secrets or variables on Cloudflare.

| Variable                                                                                                          | Purpose                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `D6E_AUTH_BASE_URL`, `D6E_AUTH_CLIENT_ID`, `D6E_AUTH_CLIENT_SECRET`                                               | Operator OAuth against d6e-auth. The client ID is also the expected token audience.                                                                                                                                                                     |
| `SESSION_ENCRYPTION_KEY`                                                                                          | 32 random bytes, base64. Encrypts operator and recipient cookies, separated by AES-GCM additional authenticated data.                                                                                                                                   |
| `SESSION_ENCRYPTION_KEY_PREVIOUS`                                                                                 | Optional retiring session key, kept only until every issued recipient/decline cookie sealed under it has expired (30 days) or been overwritten by a fresh exchange. See rotation below.                                                                 |
| `DELIVERY_ENCRYPTION_KEY`                                                                                         | Separate AES-256 key sealing recipient capabilities and completion tokens held in delivery outboxes.                                                                                                                                                    |
| `DELIVERY_ENCRYPTION_KEY_PREVIOUS`                                                                                | Optional retiring delivery key. See rotation below.                                                                                                                                                                                                     |
| `SIGNKIT_PUBLIC_ORIGIN`                                                                                           | Exact public HTTPS origin used to build signing and completion links.                                                                                                                                                                                   |
| `SIGNKIT_EMAIL_FROM`, `SIGNKIT_EMAIL_FROM_NAME`                                                                   | Transactional sender address and display name.                                                                                                                                                                                                          |
| `DELIVERY_WORKER_SECRET`                                                                                          | High-entropy bearer secret for the protected drain endpoints.                                                                                                                                                                                           |
| `SIGNKIT_BOOTSTRAP_OWNER_EMAIL`                                                                                   | Optional. Restricts instance bootstrap to one verified email; see [Claim the initial owner immediately after deploy](#claim-the-initial-owner-immediately-after-deploy). Not a secret; leave unset for local development.                               |
| `SIGNKIT_MAIL_PROVIDER`                                                                                           | Mail transport: exactly `smtp` or `cloudflare`. Required on Node/Docker and Vercel; on Workers it already ships as a non-secret `cloudflare` value in `wrangler.jsonc`/`wrangler.build.jsonc`, the only supported value there. See [Mail](#mail) above. |
| `SIGNKIT_SMTP_HOST`, `SIGNKIT_SMTP_PORT`, `SIGNKIT_SMTP_SECURE`, `SIGNKIT_SMTP_USERNAME`, `SIGNKIT_SMTP_PASSWORD` | SMTP connection settings for `SIGNKIT_MAIL_PROVIDER=smtp` (Node/Docker and Vercel only). Covers Resend and any other SMTP-speaking provider.                                                                                                            |
| `DATABASE_URL`                                                                                                    | PostgreSQL connection string (Node and Vercel profiles).                                                                                                                                                                                                |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`        | Object storage for the Node and Vercel profiles.                                                                                                                                                                                                        |
| `CLOUDFLARE_EMAIL_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN`                                                       | Cloudflare Email Sending REST credentials for `SIGNKIT_MAIL_PROVIDER=cloudflare` on Node/Docker and Vercel.                                                                                                                                             |

### Claim the initial owner immediately after deploy

There is no bootstrap secret gating `POST /api/v1/instance/bootstrap` by default — it authorizes on the verified d6e-auth cookie session alone (see [architecture/authorization-and-instance-administration.md § Instance bootstrap](architecture/authorization-and-instance-administration.md#instance-bootstrap) and the first-user-wins risk in [architecture/deployment-and-risks.md § Primary risks](architecture/deployment-and-risks.md#primary-risks)). The first authenticated identity to reach the instance claims the sole `owner` slot, and the app forces every authenticated caller straight to `/setup` until that happens. Complete this claim yourself right after deploying and before advertising the instance's URL to anyone else: every minute the instance sits reachable and unclaimed is a minute a stranger who discovers the URL and signs in through d6e-auth first becomes the owner instead of you.

Optionally, set `SIGNKIT_BOOTSTRAP_OWNER_EMAIL` (as a Worker var/secret on Cloudflare, or in the environment on Node/Docker/Vercel) to the intended owner's verified email before the first deploy. A verified caller whose email does not match is refused with 403 and the empty-instance window stays open, so the real owner can still claim it afterward. This is plain deployment configuration, not a cryptographic key: it never appears in logs or responses, and it stops mattering entirely once the instance is bootstrapped. Leaving it unset preserves the original first-user-wins behavior — the default, and the local-development escape hatch, since nothing needs to be configured to develop locally.

### Rotating `DELIVERY_ENCRYPTION_KEY` and `SESSION_ENCRYPTION_KEY`

Both keys support an active+previous keyring, so rotation is safe: opening ciphertext is fail-closed by the explicit key ID recorded alongside it (the outbox row's `sealing_key_id` column, or the key ID embedded in the cookie envelope), and only the active key or the configured `_PREVIOUS` key can ever decrypt — never a key outside that pair.

1. Set `DELIVERY_ENCRYPTION_KEY_PREVIOUS` (or `SESSION_ENCRYPTION_KEY_PREVIOUS`) to the current value of the key you are retiring.
2. Set `DELIVERY_ENCRYPTION_KEY` (or `SESSION_ENCRYPTION_KEY`) to a fresh 32 random bytes, base64.
3. Deploy. New ciphertext seals under the new active key immediately; ciphertext already sealed under the previous key keeps opening correctly.
4. Let the reseal sweep (below) migrate outstanding outbox ciphertext onto the active key over the following runs. Cookies migrate opportunistically the next time a session is resealed on a successful request; leave `_PREVIOUS` set for at least 30 days (the cookie/capability lifetime) so any cookie or capability that never gets resealed can still be opened.
5. Once no outbox row reports the retired key ID and 30 days have passed, unset `_PREVIOUS`. A key ID outside the active/previous pair fails closed rather than being silently accepted — this is a deliberate integrity guarantee, not a bug to work around by widening the keyring.

## Background jobs

Durable outboxes, expiry, reseal, webhook delivery, and object-store orphan collection are processed through protected endpoints:

| Endpoint                                                 | Work                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `POST /api/v1/system/deliveries/drain`                   | recipient invitation mail                                               |
| `POST /api/v1/system/deliveries/reseal-sweep`            | migrates outstanding delivery capability ciphertext onto the active key |
| `POST /api/v1/system/completion-artifacts/drain`         | completion-artifact publication                                         |
| `POST /api/v1/system/completion-deliveries/drain`        | completion notifications and read-only artifact access grants           |
| `POST /api/v1/system/completion-deliveries/reseal-sweep` | migrates outstanding completion token ciphertext onto the active key    |
| `POST /api/v1/system/envelopes/expiry-drain`             | transitions lapsed `sent`/`in_progress` envelopes to `expired`          |
| `POST /api/v1/system/webhooks/drain`                     | signed webhook deliveries                                               |
| `POST /api/v1/system/objects/orphan-sweep`               | deletes unreferenced object-store uploads older than 24 hours           |

All endpoints authenticate with a constant-time check of `Authorization: Bearer <DELIVERY_WORKER_SECRET>`. Cloudflare invokes them from its own scheduled trigger. Node/Docker and Vercel deployments must POST each path from a host scheduler (systemd timer, Kubernetes CronJob, or equivalent) roughly once a minute, for example:

```sh
for path in \
  /api/v1/system/deliveries/drain \
  /api/v1/system/deliveries/reseal-sweep \
  /api/v1/system/completion-artifacts/drain \
  /api/v1/system/completion-deliveries/drain \
  /api/v1/system/completion-deliveries/reseal-sweep \
  /api/v1/system/envelopes/expiry-drain \
  /api/v1/system/webhooks/drain \
  /api/v1/system/objects/orphan-sweep
do
  curl -fsS -X POST "${SIGNKIT_PUBLIC_ORIGIN}${path}" \
    -H "Authorization: Bearer ${DELIVERY_WORKER_SECRET}"
done
```

Responses and logs carry only stable delivery IDs, counts, outcomes, and sanitized error codes — never object keys, ciphertext, or secrets.

Each delivery drain claims work with bounded leases, reclaims abandoned leases after five minutes, and backs off retryable failures. The external mail call is not inside the database transaction, so provider acceptance and database completion form an **at-least-once** boundary: after an ambiguous process failure, a message can be sent twice. Mail recipients must tolerate rare duplicates. Delivery semantics, terminal-failure classification, and ciphertext scrubbing rules are specified in [architecture/completion-artifacts.md](architecture/completion-artifacts.md#completion-artifact-delivery-and-public-access-slice-b) and summarized in [api.md](api.md#background-drains).

The reseal sweeps are bounded maintenance, not delivery: each run migrates at most 50 non-`processing` outbox rows sealed under a key other than the active one, leaving rows sealed under a key outside the active/previous pair untouched for an operator to investigate rather than silently discarding them.

The envelope expiry drain discovers `sent`/`in_progress` envelopes where every actionable (signer/approver) recipient that has ever been released has an expired capability and none currently has a live one, then transitions each envelope to `expired` with the same delivery-outbox scrub and capability revocation as an operator void, plus a chained `envelope.expired` audit event.

The orphan sweep lists at most 1,000 objects per run, skips anything younger than 24 hours or without a parseable upload time, and deletes only keys that SQL does not currently reference. A durable, server-owned resume key advances across scheduled runs so a first page of live objects cannot starve later orphans; callers cannot supply that cursor, shorten the grace period, or name a prefix. Failed pointer CAS uploads remain invisible until they age out and are collected.

## Disaster recovery

Point-in-time D1 restore, R2 object recovery, PostgreSQL backup/restore, and S3-compatible object storage backup/restore runbooks live in [docs/operations/](operations/README.md); they are deliberately generic (no account, database, bucket, or Worker names) so they stay accurate as this deployment's specific resource names change.
