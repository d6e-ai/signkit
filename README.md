# SignKit

SignKit is an open-core, Markdown-native agreement and electronic-signature platform. It is designed so the browser, AI agents, and a future Rust CLI use the same application commands and evidence model.

The current repository contains the product shell, portable deployment boundary, core domain policies, an organization-scoped Envelope API, PostgreSQL/D1 migrations, S3/R2 adapters, d6e-auth OAuth integration, bounded compressed Git-history persistence, and an atomic recipient/readiness command. It is not yet a production signing service; public recipient signing, PDF sealing, mail delivery, and durable jobs remain on the implementation backlog.

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

The first agent-facing endpoints are `POST /api/v1/envelopes`, `GET /api/v1/envelopes`, `GET /api/v1/envelopes/{envelopeId}`, `GET /api/v1/envelopes/{envelopeId}/draft`, `POST /api/v1/envelopes/{envelopeId}/draft/commits`, and `POST /api/v1/envelopes/{envelopeId}/ready`. Mutations require an authenticated d6e-auth organization and an `Idempotency-Key` header. Draft commits use expected-generation concurrency and optional automation provenance. The ready command supplies the same expected Git generation plus the complete normalized recipient graph; it stores the graph, changes `draft` to `ready`, and appends `envelope.ready` atomically. The same key and normalized request replay the original receipt; key reuse or stale state returns an RFC 9457 conflict. Responses keep storage keys, archive bytes, and future capability secrets internal.

The implementation backlog is tracked in [GitHub Issues](https://github.com/d6e-ai/signkit/issues), including DOCX conversion, agent workload credentials and a Rust CLI, enterprise SSO/audit export boundaries, and the lower-priority Vercel production profile.
