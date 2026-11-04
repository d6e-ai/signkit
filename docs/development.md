# Development

Local setup, tests, builds, and what CI enforces. For runtime configuration and hosting see
[deployment.md](deployment.md); for the normative architecture see
[architecture/](architecture/README.md).

## Prerequisites

- Node.js 22.18 or newer (typed cf configuration requires 22.18; CI verifies Node 22; the Docker
  image uses Node 26).
- pnpm 11.24.0 (pinned via `packageManager`; Node 26 no longer bundles Corepack).
- Chromium for the browser test project: `pnpm exec playwright install chromium`.
- Optional for integration tests and the Node profile: PostgreSQL 18.

## Setup

```sh
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
pnpm run dev
```

`pnpm install` runs `prepare`, which generates cf binding/runtime types, compiles Paraglide
messages, and syncs SvelteKit types. `.env` holds the Node development configuration; every variable
is described in [deployment.md](deployment.md#configuration). Cloudflare secrets never belong in
`.env` — use Worker secret storage, or `.dev.vars` locally, and keep both out of Git. After an
installation with `--ignore-scripts`, run `pnpm run prepare` before building.

## Tests

```sh
pnpm run test          # server suite, then the browser suite
pnpm run test:unit     # vitest --project server (node environment)
pnpm run test:browser  # vitest --project browser (Chromium)
```

The server project covers domain, application, and adapter suites, including D1 behaviour through an
in-process SQLite harness. The browser project runs the recipient-surface fixtures in real Chromium.

PostgreSQL integration suites are skipped unless `POSTGRES_TEST_URL` points at a disposable
database:

```sh
POSTGRES_TEST_URL=postgres://signkit_test:signkit_test@127.0.0.1:5432/signkit_test pnpm run test:unit -- --run
```

These suites apply migrations and write data; never aim them at a database you care about.

CI also runs `scripts/test-cli-recipient-e2e.mjs` against the built Node server, a disposable
PostgreSQL 18 database, and a disposable SeaweedFS S3-compatible bucket. It drives the real Rust CLI
through create, PDF upload, ready, field placement, send, recipient PDF review/viewed/sign,
completion evidence/PDF, and a separate approver flow. Only external OAuth login and SMTP delivery
are outside this test: the harness seeds a test-only member/API key and opens its own invitation
capability from the encrypted local outbox. No browser or sender key performs a recipient action,
and the test checks that credentials are absent from CLI output, server logs, and audit payloads.
The script requires loopback endpoints and dedicated `signkit_cli_e2e` database and
`signkit-cli-e2e` bucket names.

## Static checks and formatting

```sh
pnpm run lint    # prettier --check . && eslint .
pnpm run check   # cf type generation + Paraglide compile + svelte-kit sync + svelte-check
pnpm run format  # prettier --write .
```

## Builds

`DEPLOY_TARGET` selects the SvelteKit adapter at build time, so each target is a separate artifact:

```sh
pnpm run build:node        # default profile, adapter-node into build/node
pnpm run build:cloudflare  # SvelteKit adapter + cf Build Output
pnpm run build:vercel      # adapter-vercel, nodejs22.x
```

`pnpm run test:node-build` smoke-checks the Node bundle after `build:node`.

## PostgreSQL local loop

```sh
DATABASE_URL=postgres://signkit:change-me@localhost:5432/signkit pnpm run db:migrate:postgres        # apply migrations/postgres
DATABASE_URL=postgres://signkit:change-me@localhost:5432/signkit pnpm run db:migrate:postgres:check   # report pending/drift only, writes nothing
```

`scripts/postgres-migrate.mjs` is the same migration runner used in production (see
[deployment.md § Applying PostgreSQL migrations](deployment.md#applying-postgresql-migrations));
local development does not need the role separation described there, since a local database has no
other tenant to protect.

## Cloudflare local loop

```sh
pnpm run cf:typegen  # regenerate .cloudflare/types/index.d.ts
pnpm run build:cloudflare
pnpm exec cf deploy --prebuilt --dry-run  # validates only; does not deploy
pnpm run test:cloudflare-tooling

# cf beta.14 cannot apply the complete local migration set reliably yet.
pnpm exec wrangler d1 migrations apply signkit --config wrangler.jsonc --local --persist-to .cloudflare/state
```

Binding types are generated, not hand-written; regenerate them whenever `cloudflare.config.ts`
bindings change. `prepare` and `check` do this automatically. The beta's pnpm workspace framework
detection is isolated by the build wrapper; use `pnpm run build:cloudflare`, not bare `cf build` at
this workspace root. See [architecture/cloudflare-tooling.md](architecture/cloudflare-tooling.md)
for the configuration boundary and the explicit local-D1 fallback.

An intentional source deployment uses `pnpm run deploy:cloudflare` (build plus
`cf deploy --prebuilt`). Authenticate cf separately from Wrangler with `pnpm exec cf auth login`,
select `CLOUDFLARE_ACCOUNT_ID` in the environment, and configure bindings/vars/secrets before
deploying. `SIGNKIT_D1_DATABASE_ID` optionally pins the `DB` binding at build time. For managed
installations and upgrades, prefer the verified release flow in
[create-signkit.md](create-signkit.md).

## Migrations

`migrations/postgres` and `migrations/d1` are separate dialect-specific sets behind the same ports.
Schema changes need both dialects plus matching fresh-schema and adapter tests. One database is one
instance. Apply forward migrations without editing applied SQL; see
[migration policy](architecture/persistence.md#migration-policy) for the incompatible pre-release
epoch boundary. A newer release alone is never a reason to delete a database.

D1 migrations must pass both the local and remote statement splitters. In trigger bodies,
parenthesize `CASE` expressions as `SELECT (CASE WHEN ... END);` so the expression's `END` cannot
terminate the trigger. `d1-migration-statement-parsing.spec.ts` checks the whole migration set
against both splitter behaviors.

Keep D1 LIKE/GLOB patterns short: use bounded prefix or negated-character patterns, with shape
checked by `length` and `substr`. Local `node:sqlite` limits do not establish D1 compatibility.
Validate canonical UTC millisecond timestamps with `strftime('%Y-%m-%dT%H:%M:%fZ', col) IS col`;
`IS` rejects an invalid parse that `=` could accept as NULL. `d1-glob-pattern-complexity.spec.ts`
enforces the pattern budget and accepted/rejected timestamp shapes.

A new SignKit-owned identifier column needs the UUIDv7 check in both dialects (PostgreSQL regex, D1
`length`/`substr`/`NOT GLOB`) and a case in each parity suite:
`postgres-migrations.integration.spec.ts` and `d1-uuidv7-identifier-constraints.spec.ts`. Mint the
value with `newUuidV7` from `src/lib/ids/uuid-v7.ts` — never with `crypto.randomUUID`, and never for
external identity, idempotency keys, or secret material — see
[architecture/identifiers.md](architecture/identifiers.md#identifiers).

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

The test suite uses `wiremock` to test against a local mock HTTP server, verifying capabilities,
envelope read endpoints, active-owner membership enforcement, secure stdin/env API-key handling,
strict redirect refusal, bounded response streaming, and exact exit-code contracts.

## create-signkit (`packages/create-signkit`)

The Cloudflare deployment CLI is a separate ESM package. It is not the Rust API CLI.

```sh
pnpm --filter create-signkit test
pnpm --filter create-signkit build
```

Tests inject HTTP and process layers and must not contact real GitHub or Cloudflare. See
[create-signkit.md](create-signkit.md).

## CI

`.github/workflows/ci.yml` does not run on pull requests or pushes. Start it by hand with
`gh workflow run ci.yml --ref <branch>` when a remote run is needed. The same checks are local work.
When started, the workflow runs:

- **validate** — `lint`, `check`, Chromium install, and the full `test` script against a
  `postgres:18-alpine` service with `POSTGRES_TEST_URL` set, so PostgreSQL integration suites always
  run in CI.
- **build** — a matrix over `node`, `cloudflare`, and `vercel`. The Node build additionally runs
  `test:node-build`; the Cloudflare build checks generated binding types, applies local D1
  migrations through the scoped Wrangler compatibility path, runs `cf deploy --prebuilt --dry-run`,
  builds create-signkit, then builds and verifies a synthetic `v0.0.0-ci` release bundle
  (`SIGNKIT_RELEASE_TAG` overrides `GITHUB_REF_NAME` so the branch name cannot become the tag) and
  deletes `.release`.
- **rust-cli** — isolated Rust CI job on Rust 1.88.0 running `cargo fmt --check`,
  `cargo clippy --locked --all-targets -- -D warnings`, and `cargo test --locked`.

Tag workflow `.github/workflows/release-cloudflare-bundle.yml` runs on `v*` tags as a draft-first
full release: it enforces tag-equals-version for the root product and Rust CLI while validating the
independently versioned `create-signkit` npm package, builds and smoke-checks the Node profile,
builds and verifies the Cloudflare bundle, builds the Rust `--locked --release` binary and the
Docker image, regenerates a unified `.release/assets/SHA256SUMS`, verifies it, and generates GitHub
build-provenance attestations. Assets are uploaded only to a draft; reruns reuse byte-identical
existing assets and refuse public releases, metadata drift, unexpected assets, or content mismatches
rather than clobbering them. Only then may job `publish-npm` run `npm publish` for create-signkit
with the exact npm CLI pinned by root `package.json` and `pnpm-lock.yaml` (OIDC Trusted Publishing
only, with no token fallback; pnpm installs and invokes it). Job `publish-release` receives the
build job's exact asset SHA-256 inventory, re-downloads the exact remote set and byte-verifies it
immediately before marking the draft public, and runs only after `publish-npm` succeeds. Repository
immutable releases must also be enabled before pushing the tag; workflow checks do not replace that
administrative control. A tag therefore never leaves a public release behind an unpublished npm
package, but perfect cross-registry atomicity is impossible and recovery is documented in the
workflow header. All named setup and attestation actions are pinned to reviewed full commit SHAs
with version comments. `create-signkit` requires online GitHub/Sigstore verification of the exact
downloaded Cloudflare bundle before plan output or any deploy/upgrade mutation; manifest SHA-256
remains an integrity check rather than a signature. The npm package's prerelease version selects
dist-tag `beta`; stable package versions publish to `latest`. The package has completed its one-time
manual first publish, so normal releases use OIDC Trusted Publishing only. See
[release-checklist.md](release-checklist.md) for the non-publishing local verification that precedes
any tag push.
