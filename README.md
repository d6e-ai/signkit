# SignKit

SignKit is an open-core, Markdown-native agreement and electronic-signature platform. It is designed so the browser, AI agents, and a future Rust CLI use the same application commands and evidence model.

The current repository contains the product shell, portable deployment boundary, core domain policies, an organization-scoped Envelope API, PostgreSQL/D1 migrations, S3/R2 adapters, d6e-auth OAuth integration, and bounded compressed Git-history persistence with idempotent draft commits. It is not yet a production signing service; public recipient signing, PDF sealing, mail delivery, and durable jobs remain on the implementation backlog.

## Development

```sh
pnpm install
pnpm run dev
```

The default build is the Node/Docker profile:

```sh
pnpm run build:node
pnpm run build:cloudflare
pnpm run build:vercel
```

Cloudflare binding types and local migrations:

```sh
pnpm run cf:typegen
pnpm exec wrangler d1 migrations apply signkit --local
```

Copy `.env.example` to `.env` for Node development. Cloudflare secrets belong in Wrangler secret storage or `.dev.vars` locally and must not be committed.

## Deployment profiles

| Target             | Database   | Object storage          | Status               |
| ------------------ | ---------- | ----------------------- | -------------------- |
| Node/Docker        | PostgreSQL | S3-compatible           | scaffolded           |
| Cloudflare Workers | D1 binding | R2 binding              | scaffolded           |
| Vercel             | PostgreSQL | S3-compatible initially | low-priority backlog |

See [docs/design.md](docs/design.md) for the normative architecture and security boundaries.

The first agent-facing endpoints are `POST /api/v1/envelopes`, `GET /api/v1/envelopes`, `GET /api/v1/envelopes/{envelopeId}`, `GET /api/v1/envelopes/{envelopeId}/draft`, and `POST /api/v1/envelopes/{envelopeId}/draft/commits`. Mutations require an authenticated d6e-auth organization and an `Idempotency-Key` header. The draft commit body supplies the expected generation, a one-line message, one or more `documents/*.md` edits, and optional automation provenance. The same key and normalized request replay the original revision; key reuse or a stale generation returns an RFC 9457 conflict. Draft responses expose the stable Git generation, commit, archive digest, and normalized Markdown while keeping storage keys and archive bytes internal.

The implementation backlog is tracked in [GitHub Issues](https://github.com/d6e-ai/signkit/issues), including DOCX conversion, agent workload credentials and a Rust CLI, enterprise SSO/audit export boundaries, and the lower-priority Vercel production profile.
