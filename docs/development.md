# Development

Local setup, tests, builds, and what CI enforces. For runtime configuration and hosting see [deployment.md](deployment.md); for the normative architecture see [design.md](design.md).

## Prerequisites

- Node.js 22 (the Docker image and CI both use Node 22).
- pnpm 11.24.0 (pinned via `packageManager`; `corepack enable` is enough).
- Chromium for the browser test project: `pnpm exec playwright install chromium`.
- Optional for integration tests and the Node profile: PostgreSQL 18.

## Setup

```sh
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
pnpm run dev
```

`pnpm install` runs `prepare`, which compiles Paraglide messages and syncs SvelteKit types. `.env` holds the Node development configuration; every variable is described in [deployment.md](deployment.md#configuration). Cloudflare secrets never belong in `.env` — use Wrangler secret storage, or `.dev.vars` locally, and keep both out of Git.

## Tests

```sh
pnpm run test          # server suite, then the browser suite
pnpm run test:unit     # vitest --project server (node environment)
pnpm run test:browser  # vitest --project browser (Chromium)
```

The server project covers domain, application, and adapter suites, including D1 behaviour through an in-process SQLite harness. The browser project runs the recipient-surface fixtures in real Chromium.

PostgreSQL integration suites are skipped unless `POSTGRES_TEST_URL` points at a disposable database:

```sh
POSTGRES_TEST_URL=postgres://signkit_test:signkit_test@127.0.0.1:5432/signkit_test pnpm run test:unit -- --run
```

These suites apply migrations and write data; never aim them at a database you care about.

## Static checks and formatting

```sh
pnpm run lint    # prettier --check . && eslint .
pnpm run check   # Paraglide compile + svelte-kit sync + svelte-check
pnpm run format  # prettier --write .
```

## Builds

`DEPLOY_TARGET` selects the SvelteKit adapter at build time, so each target is a separate artifact:

```sh
pnpm run build:node        # default profile, adapter-node into build/node
pnpm run build:cloudflare  # adapter-cloudflare, uses wrangler.build.jsonc
pnpm run build:vercel      # adapter-vercel, nodejs22.x
```

`pnpm run test:node-build` smoke-checks the Node bundle after `build:node`.

## Cloudflare local loop

```sh
pnpm run cf:typegen                                   # regenerate src/worker-configuration.d.ts
pnpm exec wrangler d1 migrations apply signkit --local # apply migrations/d1 to the local D1
pnpm run deploy:cloudflare                             # build:cloudflare + wrangler deploy
```

Binding types are generated, not hand-written; regenerate them whenever `wrangler.jsonc` bindings change.

## Migrations

`migrations/postgres` and `migrations/d1` are maintained as separate dialect-specific sets behind the same ports. A schema change usually means writing both, plus the matching migration specs. The shared model avoids database enums, arrays, and dialect-specific JSON column types. Tenant-owned tables carry `organization_id` in their keys and foreign keys; instance-scoped `instance_member` / `instance_bootstrap` / `api_key` tables do not — see [design.md § Persistence](design.md#persistence). `api_key_organization_grant` and its two command receipts are the deliberate exception: they are instance-scoped rows that name an organization, because bridging a local key to an external d6e tenant is exactly their purpose. SignKit is unreleased, so rewritten migrations require a local database reset rather than a compatibility migration.

A new SignKit-owned identifier column needs the UUIDv7 check in both dialects (PostgreSQL regex, D1 `length`/`substr`/`NOT GLOB`) and a case in each parity suite: `postgres-migrations.integration.spec.ts` and `d1-uuidv7-identifier-constraints.spec.ts`. Mint the value with `newUuidV7` from `src/lib/ids/uuid-v7.ts` — never with `crypto.randomUUID`, and never for external identity, idempotency keys, or secret material — see [design.md § Identifiers](design.md#identifiers).

## Repository layout

| Path                         | Contents                                                              |
| ---------------------------- | --------------------------------------------------------------------- |
| `src/routes`                 | SvelteKit pages, `/api/v1` handlers, `/s/{token}`, `/c/{token}`, auth |
| `src/lib/domain`             | envelope, recipient, field, and audit policies                        |
| `src/lib/application`        | commands and queries shared by the UI and the API                     |
| `src/lib/ids`                | the single UUIDv7 generator for persistent identifiers                |
| `src/lib/ports`              | database, object store, identity, and mail interfaces                 |
| `src/lib/adapters`           | PostgreSQL/D1, S3/R2, and mail implementations                        |
| `src/lib/history`            | bounded Git draft repository handling                                 |
| `cli`                        | production Rust CLI workspace (`signkit`)                             |
| `migrations/{postgres,d1}`   | dialect-specific SQL migrations                                       |
| `messages`, `project.inlang` | Paraglide `en`/`ja` message catalogues                                |

## Rust CLI (`cli/`)

The Rust CLI workspace lives in `cli/` with binary target `signkit`.

```sh
cd cli
cargo fmt --check
cargo check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build
```

The test suite uses `wiremock` to test against a local mock HTTP server, verifying capabilities, envelope read endpoints, mandatory organization enforcement, secure stdin/env API-key handling, strict redirect refusal, bounded response streaming, and exact exit-code contracts.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`:

- **validate** — `lint`, `check`, Chromium install, and the full `test` script against a `postgres:18-alpine` service with `POSTGRES_TEST_URL` set, so PostgreSQL integration suites always run in CI.
- **build** — a matrix over `node`, `cloudflare`, and `vercel`. The Node build additionally runs `test:node-build`; the Cloudflare build checks generated binding types, applies local D1 migrations, and runs `wrangler deploy --dry-run`.
