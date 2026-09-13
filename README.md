# SignKit

SignKit is an open-core, Markdown-native agreement and electronic-signature platform. Agreements are ordinary Markdown documents with a real Git history, and the browser UI, AI agents, and integrators all drive the same versioned application API.

## Project status

SignKit is under active development and is **not yet a production signing service**.

What exists today: the product shell and portable deployment boundary, core domain policies, an organization-scoped Envelope API, PostgreSQL and D1 migrations, S3/R2 adapters, d6e-auth OAuth, bounded compressed Git draft history, recipient/readiness, send, void, and recipient decision commands (view, decline, approve, sign), durable invitation delivery, immutable completion-artifact publication, completion delivery with fail-closed public recipient and completion access, and the first-party Rust CLI slice (`signkit` under `cli/`) for capabilities and API-key `envelopes:read` inspection.

What does not exist yet: ink capture, PDF sealing, DOCX conversion, and CLI mutations / write scopes. See the [issue tracker](https://github.com/d6e-ai/signkit/issues) for the backlog.

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

| Target             | Database      | Object storage          | Background work                | Status               |
| ------------------ | ------------- | ----------------------- | ------------------------------ | -------------------- |
| Node/Docker        | PostgreSQL 18 | S3-compatible           | host scheduler calls drains    | scaffolded           |
| Cloudflare Workers | D1 binding    | R2 binding              | one-minute scheduled trigger   | scaffolded           |
| Vercel             | PostgreSQL    | S3-compatible initially | platform-specific, unspecified | low-priority backlog |

`DEPLOY_TARGET` selects the profile at build time; there is no universal runtime build. Vercel compiles in CI but is not supported for production. Details in [docs/deployment.md](docs/deployment.md).

## Agent skills

SignKit provides two repository-packaged agent skills. Users can discover and install them with `npx skills add https://github.com/d6e-ai/signkit`:

```sh
npx skills add https://github.com/d6e-ai/signkit
```

- `signkit-api` — Calling the `/api/v1` HTTP API, capability discovery, organization scoping, read-only API-key inspection, UUIDv7 validation, and RFC 9457 error handling.
- `signkit-cli` — Building, configuring, and operating the read-only Rust CLI (`signkit`), credential hygiene, loopback networking, and exit codes.

## Documentation

- [docs/architecture/](docs/architecture/README.md) — normative architecture, security, and evidence contracts.
- [docs/api.md](docs/api.md) — current HTTP surface and its operational semantics.
- [docs/cli.md](docs/cli.md) — agent-first Rust CLI reference, commands, security, and exit codes.
- [docs/deployment.md](docs/deployment.md) — deployment profiles, configuration, and background jobs.
- [docs/development.md](docs/development.md) — local setup, tests, builds, and CI expectations.
- [docs/operations/](docs/operations/README.md) — D1 Time Travel and R2 restore runbooks.

## License

AGPL-3.0-only. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
