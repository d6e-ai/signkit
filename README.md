# SignKit

SignKit is an open-core, Markdown-native agreement and electronic-signature platform. Agreements are ordinary Markdown documents with a real Git history, and the browser UI, AI agents, and integrators all drive the same versioned application API.

## Project status

SignKit v0.1.0 is production-ready for self-hosted electronic-signature workflows on Node/Docker and Cloudflare Workers.

Shipped in v0.1.0:

- Instance-scoped Envelope API with Markdown drafts under bounded Git history, recipient readiness, send/void/reissue, and recipient decisions (view, decline, approve, sign)
- Deterministic executed agreement PDFs rendered from the pinned revision, with immutable completion artifacts and hash-chained audit evidence re-derived from Git plus SQL
- Fail-closed secure bootstrap (configured owner email; local-only unsafe opt-in), d6e-auth OAuth, owner-bound API-key agent access, and signed retryable webhooks behind a deployer allowlist
- PostgreSQL 18 and D1 migrations with parity suites, S3-compatible and R2 object storage, durable background drains with bounded leases, and backup/restore runbooks for PostgreSQL/S3 and D1-Time-Travel/R2
- First-party Rust CLI (`signkit` under `cli/`) and the Cloudflare deployment CLI (`create-signkit --cloudflare ...`) that reconciles Worker/D1/R2 from GitHub Releases

Scope: SignKit is an electronic-signature workflow service. A configured external provider and independent validator can optionally add a PAdES B-B or RFC 3161-backed B-T **instance seal** to the completed PDF. That instance signature does not turn recipient decisions into certificate-backed or qualified electronic signatures; B-LT/B-LTA are not supported.

## Core ideas

- **Markdown documents, Git history.** Each envelope owns one Git repository of `documents/*.md`. Drafts are committed with expected-generation concurrency, and sending pins an immutable commit that every later read and evidence artifact resolves from.
- **Agent- and API-first.** There is no private UI backdoor: the first-party interface calls the same `/api/v1` commands agents do. Mutations require an `Idempotency-Key` and the expected state or Git generation, and errors are RFC 9457 problem documents.
- **Self-hostable and open.** The core is AGPL-3.0-only and runs on your own infrastructure. Security and evidence collection are never paywalled.
- **Portable targets.** One codebase builds separate artifacts for Node/Docker, Cloudflare Workers, and Vercel behind the same domain-shaped ports.
- **Evidence that states its own limits.** Audit events are append-only and hash-chained, and completion artifacts are re-derived from the pinned commit plus SQL evidence. This is a re-derivation guarantee, not a tamper-proof claim.

## Quick start

```sh
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
pnpm run dev
```

Fill in `.env` with your d6e-auth client, encryption keys, public origin, and PostgreSQL/S3 settings before exercising anything beyond the shell. See [docs/development.md](docs/development.md) for tests, builds, and the Cloudflare local loop.

## Deployment profiles

| Target             | Database      | Object storage          | Background work                | Status           |
| ------------------ | ------------- | ----------------------- | ------------------------------ | ---------------- |
| Node/Docker        | PostgreSQL 18 | S3-compatible           | host scheduler calls drains    | supported        |
| Cloudflare Workers | D1 binding    | R2 binding              | one-minute scheduled trigger   | supported        |
| Vercel             | PostgreSQL    | S3-compatible initially | platform-specific, unspecified | CI-only, backlog |

`DEPLOY_TARGET` selects the profile at build time; there is no universal runtime build. Vercel compiles in CI but is experimental and not supported for production. Details in [docs/deployment.md](docs/deployment.md).

## Agent skills

SignKit provides two repository-packaged agent skills. Users can discover and install them with `npx skills add https://github.com/d6e-ai/signkit`:

```sh
npx skills add https://github.com/d6e-ai/signkit
```

- `signkit-api` — Calling the `/api/v1` HTTP API, capability discovery, instance-scoped API-key reads and authoring/send mutations, UUIDv7 validation, and RFC 9457 error handling.
- `signkit-cli` — Building, configuring, and operating the agent-first Rust CLI (`signkit`), credential hygiene, loopback networking, mutations, DOCX import/export, and exit codes.

## Documentation

- [docs/architecture/](docs/architecture/README.md) — normative architecture, security, and evidence contracts.
- [docs/api.md](docs/api.md) — current HTTP surface and its operational semantics.
- [docs/cli.md](docs/cli.md) — agent-first Rust CLI reference, commands, security, and exit codes.
- [docs/create-signkit.md](docs/create-signkit.md) — Cloudflare deployment CLI (`create-signkit`), distinct from the Rust API CLI.
- [docs/deployment.md](docs/deployment.md) — deployment profiles, configuration, and background jobs.
- [docs/development.md](docs/development.md) — local setup, tests, builds, and CI expectations.
- [docs/operations/](docs/operations/README.md) — D1 Time Travel and R2 restore runbooks.

## License

AGPL-3.0-only. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
