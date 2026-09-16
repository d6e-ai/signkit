# Development

Local setup, tests, builds, and what CI enforces. For runtime configuration and hosting see [deployment.md](deployment.md); for the normative architecture see [architecture/](architecture/README.md).

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

## PostgreSQL local loop

```sh
DATABASE_URL=postgres://signkit:change-me@localhost:5432/signkit pnpm run db:migrate:postgres        # apply migrations/postgres
DATABASE_URL=postgres://signkit:change-me@localhost:5432/signkit pnpm run db:migrate:postgres:check   # report pending/drift only, writes nothing
```

`scripts/postgres-migrate.mjs` is the same migration runner used in production (see [deployment.md § Applying PostgreSQL migrations](deployment.md#applying-postgresql-migrations)); local development does not need the role separation described there, since a local database has no other tenant to protect.

## Cloudflare local loop

```sh
pnpm run cf:typegen                                   # regenerate src/worker-configuration.d.ts
pnpm exec wrangler d1 migrations apply signkit --local # apply migrations/d1 to the local D1
pnpm run deploy:cloudflare                             # build:cloudflare + wrangler deploy
```

Binding types are generated, not hand-written; regenerate them whenever `wrangler.jsonc` bindings change.

## Migrations

`migrations/postgres` and `migrations/d1` are maintained as separate dialect-specific sets behind the same ports. A schema change usually means writing both, plus matching fresh-schema and adapter tests. The shared model avoids database enums, arrays, and dialect-specific JSON column types. One database is one instance; see [architecture/persistence.md](architecture/persistence.md). The 2026-09-16 single-instance change rewrote both pre-release histories, so databases created from older tags must be deleted and recreated. `wrangler d1 migrations apply` cannot repair an already-applied migration whose text changed.

D1 migrations are also parsed twice, and only one of the two parsers is exercised locally. `wrangler d1 migrations apply` posts each migration to D1's `/query` endpoint as a single `sql` string, so the server splits it into statements; that splitter tracks `BEGIN ... END` trigger bodies but not `CASE ... END` expressions, and a bare `END;` inside a trigger body closes the trigger early and fails the whole migration with `incomplete input: SQLITE_ERROR [code: 7500]`. Inside a D1 trigger body, therefore, every `CASE` expression is parenthesized — `SELECT (CASE WHEN ... END);` — so its `END` is followed by `)` and only the trigger's own `END;` terminates the statement. `d1-migration-statement-parsing.spec.ts` applies the whole migration set through Wrangler's own splitter and through a model of D1's remote splitter, and fails if the two disagree.

D1 also caps LIKE/GLOB pattern complexity far below SQLite's own default, and rejects a longer pattern at evaluation time — not at migration time — with `LIKE or GLOB pattern too complex`. Nothing local reproduces it, because `node:sqlite` keeps the default limit, so an over-long pattern applies cleanly and passes every local spec while the same `INSERT` fails on D1: a per-character timestamp pattern in `0001_core.sql` broke instance bootstrap that way, since the first write of a fresh deployment is the `instance_member` row it guarded. D1 patterns therefore stay short — negated character classes such as `NOT GLOB '*[^0-9a-f]*'` and prefix globs — with any fixed shape spelled out in `length` and `substr`. Canonical UTC ISO-8601 millisecond timestamps are validated as `strftime('%Y-%m-%dT%H:%M:%fZ', col) IS col`, where `IS` rather than `=` is what makes an unparsable value fail the CHECK instead of passing it on a NULL. `d1-glob-pattern-complexity.spec.ts` holds every pattern to a byte budget, fails if a pattern is written in a shape it cannot scan, and pins the accepted and rejected timestamp shapes. That fix rewrote the baselines it touched, so it carries the reset requirement above: every pre-release D1 that applied the old baselines has to be recreated.

A new SignKit-owned identifier column needs the UUIDv7 check in both dialects (PostgreSQL regex, D1 `length`/`substr`/`NOT GLOB`) and a case in each parity suite: `postgres-migrations.integration.spec.ts` and `d1-uuidv7-identifier-constraints.spec.ts`. Mint the value with `newUuidV7` from `src/lib/ids/uuid-v7.ts` — never with `crypto.randomUUID`, and never for external identity, idempotency keys, or secret material — see [architecture/identifiers.md](architecture/identifiers.md#identifiers).

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
| `packages/create-signkit`    | npm deployment CLI (`create-signkit --cloudflare ...`)                |
| `migrations/{postgres,d1}`   | dialect-specific SQL migrations                                       |
| `messages`, `project.inlang` | Paraglide `en`/`ja` message catalogues                                |

## Rust CLI (`cli/`)

The Rust CLI workspace lives in `cli/` with binary target `signkit` (MSRV 1.88.0).

```sh
cd cli
cargo fmt --check
cargo check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build
```

The test suite uses `wiremock` to test against a local mock HTTP server, verifying capabilities, envelope read endpoints, active-owner membership enforcement, secure stdin/env API-key handling, strict redirect refusal, bounded response streaming, and exact exit-code contracts.

## create-signkit (`packages/create-signkit`)

The Cloudflare deployment CLI is a separate ESM package. It is not the Rust API CLI.

```sh
pnpm --filter create-signkit test
pnpm --filter create-signkit build
```

Tests inject HTTP and process layers and must not contact real GitHub or Cloudflare. See [create-signkit.md](create-signkit.md).

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`:

- **validate** — `lint`, `check`, Chromium install, and the full `test` script against a `postgres:18-alpine` service with `POSTGRES_TEST_URL` set, so PostgreSQL integration suites always run in CI.
- **build** — a matrix over `node`, `cloudflare`, and `vercel`. The Node build additionally runs `test:node-build`; the Cloudflare build checks generated binding types, applies local D1 migrations, runs `wrangler deploy --dry-run`, builds create-signkit, then builds and verifies a synthetic `v0.0.0-ci` release bundle (`SIGNKIT_RELEASE_TAG` overrides `GITHUB_REF_NAME` so the branch name cannot become the tag) and deletes `.release`.
- **rust-cli** — isolated Rust CI job on Rust 1.88.0 running `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo test --locked`.

Tag workflow `.github/workflows/release-cloudflare-bundle.yml` runs on `v*` tags as a draft-first full release: it enforces tag-equals-version for the root product and Rust CLI while validating the independently versioned `create-signkit` npm package, builds and smoke-checks the Node profile, builds and verifies the Cloudflare bundle, builds the Rust `--locked --release` binary and the Docker image, regenerates a unified `.release/assets/SHA256SUMS`, verifies it, and generates GitHub build-provenance attestations. Assets are uploaded only to a draft; reruns reuse byte-identical existing assets and refuse public releases, metadata drift, unexpected assets, or content mismatches rather than clobbering them. Only then may job `publish-npm` run `npm publish` for create-signkit with the exact npm CLI pinned by root `package.json` and `pnpm-lock.yaml` (OIDC Trusted Publishing only, with no token fallback; pnpm installs and invokes it). Job `publish-release` receives the build job's exact asset SHA-256 inventory, re-downloads the exact remote set and byte-verifies it immediately before marking the draft public, and runs only after `publish-npm` succeeds. Repository immutable releases must also be enabled before pushing the tag; workflow checks do not replace that administrative control. A tag therefore never leaves a public release behind an unpublished npm package, but perfect cross-registry atomicity is impossible and recovery is documented in the workflow header. All named setup and attestation actions are pinned to reviewed full commit SHAs with version comments. `create-signkit` does not yet verify GitHub attestations, so its enforced runtime integrity remains the manifest SHA-256 from the official repository. The npm package's prerelease version selects dist-tag `beta`; stable package versions publish to `latest`. The package has completed its one-time manual first publish, so normal releases use OIDC Trusted Publishing only. See [release-checklist.md](release-checklist.md) for the non-publishing local verification that precedes any tag push.
