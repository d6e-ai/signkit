# SignKit

SignKit is an open-core, Markdown-native agreement and electronic-signature platform. It is designed so the browser, AI agents, and a future Rust CLI use the same application commands and evidence model.

The current repository contains the product shell, portable deployment boundary, core domain policies, an organization-scoped Envelope API, PostgreSQL/D1 migrations, S3/R2 adapters, d6e-auth OAuth integration, and bounded compressed Git-history persistence. It is not yet a production signing service; public recipient signing, PDF sealing, mail delivery, and durable jobs remain on the implementation backlog.

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

The first agent-facing endpoints are `POST /api/v1/envelopes`, `GET /api/v1/envelopes`, and `GET /api/v1/envelopes/{envelopeId}`. Creation requires an authenticated d6e-auth organization and an `Idempotency-Key` header. The same key replays the original result; reusing it with a different request returns an RFC 9457 conflict.

The implementation backlog is tracked in [GitHub Issues](https://github.com/d6e-ai/signkit/issues), including DOCX conversion, agent workload credentials and a Rust CLI, enterprise SSO/audit export boundaries, and the lower-priority Vercel production profile.
