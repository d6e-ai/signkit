# SignKit

SignKit is an open-core, Markdown-native agreement and electronic-signature platform. It is designed so the browser, AI agents, and a future Rust CLI use the same application commands and evidence model.

The current repository contains the product shell, portable deployment boundary, core domain policies, an organization-scoped Envelope API, PostgreSQL/D1 migrations, S3/R2 adapters, d6e-auth OAuth integration, bounded compressed Git-history persistence, atomic recipient/readiness, send, and recipient-view commands, and fail-closed public recipient capability resolution. It is not yet a production signing service; signature capture, PDF sealing, mail delivery, and durable jobs remain on the implementation backlog.

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

The first agent-facing endpoints are `POST /api/v1/envelopes`, `GET /api/v1/envelopes`, `GET /api/v1/envelopes/{envelopeId}`, `GET /api/v1/envelopes/{envelopeId}/draft`, `POST /api/v1/envelopes/{envelopeId}/draft/commits`, `POST /api/v1/envelopes/{envelopeId}/ready`, and `POST /api/v1/envelopes/{envelopeId}/send`. Mutations require an authenticated d6e-auth organization and an `Idempotency-Key` header. Draft commits use expected-generation concurrency and optional automation provenance. The ready command supplies the same expected Git generation plus the complete normalized recipient graph. Send additionally requires the ready audit event ID, pins the Git commit, reserves hashed recipient capabilities, writes encrypted delivery intents, changes `ready` to `sent`, and appends `envelope.sent` in one database transaction. The initial routing group becomes deliverable; later groups stay blocked and CC delivery remains a completion concern. The same key and normalized request replay the original receipt; key reuse or stale state returns an RFC 9457 conflict. Responses keep storage keys, archive bytes, capabilities, hashes, ciphertext, and outbox IDs internal.

`GET /api/v1/signing/context` is the separate public-recipient boundary. It accepts only a `Bearer` recipient capability, requires a non-revoked future expiry and actionable recipient/envelope state in the database query, and returns a minimal allowlisted context. Missing, malformed, unknown, expired, revoked, blocked, and inactive capabilities share one not-found response. Operator OAuth sessions and organization input are intentionally not part of this route.

`GET /api/v1/signing/documents` uses the same bearer capability to return the ordered Markdown documents from the exact Git revision pinned when the envelope was sent. The database resolves the immutable revision locator; callers cannot supply an envelope, object key, commit, or path. The archive key is re-derived, compressed bytes and gzip output are bounded, SHA-256 and Git HEAD are verified, and no organization or storage identifiers are returned.

Browser links use `/s/{capability}` only as a one-time exchange surface. An active token is encrypted into a purpose-separated, `HttpOnly`, `SameSite=Lax` cookie whose lifetime cannot exceed the durable capability expiry or 30 days, then redirected to the locale-specific clean `/{locale}/sign` URL. The signing page rechecks durable authorization before and after loading the pinned revision, never exposes the raw token to client-side code, and renders Markdown as escaped source text.

`POST /api/v1/signing/viewed` records the first foreground browser view without turning a page `GET` into a mutation. It requires the encrypted recipient cookie, an exact same-origin request, an `Idempotency-Key`, and envelope/recipient IDs that match the freshly resolved cookie context. The recipient transition, optional `sent` to `in_progress` envelope transition, durable command receipt, and `recipient.viewed` audit event publish atomically. Replays are evidence-checked; stale tabs, inactive capabilities, key reuse, and audit-head races fail closed without disclosing whether another recipient session is valid.

The implementation backlog is tracked in [GitHub Issues](https://github.com/d6e-ai/signkit/issues), including DOCX conversion, agent workload credentials and a Rust CLI, enterprise SSO/audit export boundaries, and the lower-priority Vercel production profile.
