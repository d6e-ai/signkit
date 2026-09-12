# SignKit

SignKit is an open-core, Markdown-native agreement and electronic-signature platform. It is designed so the browser, AI agents, and a future Rust CLI use the same application commands and evidence model.

The current repository contains the product shell, portable deployment boundary, core domain policies, an organization-scoped Envelope API, PostgreSQL/D1 migrations, S3/R2 adapters, d6e-auth OAuth integration, bounded compressed Git-history persistence, atomic recipient/readiness, send, delivery, and recipient-decision commands, and fail-closed public recipient capability resolution. It is not yet a production signing service; ink capture, PDF sealing, evidence export, and broader job orchestration remain on the implementation backlog.

## Development

```sh
pnpm install
pnpm exec playwright install chromium
pnpm run dev
```

`pnpm run test` runs the PostgreSQL/D1-aware server suite and the Chromium recipient-surface fixture. Set `POSTGRES_TEST_URL` to include the PostgreSQL integration tests; CI installs Chromium and provides PostgreSQL 17.

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

Cloudflare invitation delivery uses the native `EMAIL` binding and a one-minute scheduled trigger. Set `DELIVERY_ENCRYPTION_KEY`, `DELIVERY_WORKER_SECRET`, `SIGNKIT_PUBLIC_ORIGIN`, `SIGNKIT_EMAIL_FROM`, and `SIGNKIT_EMAIL_FROM_NAME` as Worker secrets or variables. Node/Docker uses the same protected drain endpoint with PostgreSQL and the Cloudflare Email Sending REST credentials in `.env.example`; invoke `POST /api/v1/system/deliveries/drain` from the host scheduler with `Authorization: Bearer <DELIVERY_WORKER_SECRET>`.

Cloudflare Email Sending is currently beta. Sending to arbitrary recipient addresses requires Workers Paid; free accounts can use verified destination addresses for testing. Check the current [Email Sending pricing and availability](https://developers.cloudflare.com/email-service/platform/pricing/) before treating the overall Cloudflare deployment as zero-cost.

## Deployment profiles

| Target             | Database   | Object storage          | Status               |
| ------------------ | ---------- | ----------------------- | -------------------- |
| Node/Docker        | PostgreSQL | S3-compatible           | scaffolded           |
| Cloudflare Workers | D1 binding | R2 binding              | scaffolded           |
| Vercel             | PostgreSQL | S3-compatible initially | low-priority backlog |

See [docs/design.md](docs/design.md) for the normative architecture and security boundaries.

The first agent-facing endpoints are `POST /api/v1/envelopes`, `GET /api/v1/envelopes`, `GET /api/v1/envelopes/{envelopeId}`, `GET /api/v1/envelopes/{envelopeId}/draft`, `POST /api/v1/envelopes/{envelopeId}/draft/commits`, `POST /api/v1/envelopes/{envelopeId}/ready`, `POST /api/v1/envelopes/{envelopeId}/fields`, `POST /api/v1/envelopes/{envelopeId}/send`, and `GET /api/v1/envelopes/{envelopeId}/deliveries`. Mutations require an authenticated d6e-auth organization and an `Idempotency-Key` header. Draft commits use expected-generation concurrency and optional automation provenance. The ready command supplies the same expected Git generation plus the complete normalized recipient graph. Send additionally requires the ready audit event ID as an immutable anchor for the same Git generation and commit, chains from the current audit head after any field-placement events, pins the Git commit, reserves hashed recipient capabilities, writes encrypted delivery intents, changes `ready` to `sent`, and appends `envelope.sent` in one database transaction. The initial routing group becomes deliverable; later groups stay blocked and CC delivery remains a completion concern. The same key and normalized request replay the original receipt; key reuse or stale state returns an RFC 9457 conflict. Responses keep storage keys, archive bytes, capabilities, hashes, ciphertext, and outbox IDs internal. The organization-authorized delivery-status query exposes only recipient IDs, roles, routing order, state, attempt/timestamp metadata, and sanitized error codes—never email, name, token material, or provider secrets.

`POST /api/v1/envelopes/{envelopeId}/fields` is an idempotent replace-all signing-field placement command, usable only while an envelope is `ready`, before it is sent. The body supplies `expectedGeneration` (the Git generation), `expectedFieldGeneration` (a compare-and-set counter for the field set itself), and 1-50 fields, each naming a recipient, a `documents/*.md` path, a `fieldType` (`signature`, `initials`, `text`, `date`, or `checkbox`), a label, whether it is required, and a semantic document-order `position`; there is no page/x/y geometry in this slice. Only signer recipients in the same organization and envelope may own a field, and every document path must exist in the exact bounded Git workspace pinned by `expectedGeneration`. Field IDs are derived deterministically from the recipient, document path, field type, and position, so replacing the set with the same declarations reproduces the same IDs. Publishing atomically rechecks generation, Git head, field generation, envelope state, and recipient scope; replaces the complete field projection; increments `expectedFieldGeneration`; and appends one PII-minimized `envelope.fields_placed` audit event. Cloudflare enforces this atomically with a rollback-on-failed-predicate D1 trigger; PostgreSQL uses ordered row locking (envelope, then referenced recipients sorted by ID) inside one transaction. The response never echoes labels, audit hashes, archive/storage identifiers, emails, names, or internal command IDs.

`GET /api/v1/signing/context` is the separate public-recipient boundary. It accepts only a `Bearer` recipient capability, requires a non-revoked future expiry and actionable recipient/envelope state in the database query, and returns a minimal allowlisted context. Missing, malformed, unknown, expired, revoked, blocked, and inactive capabilities share one not-found response. Operator OAuth sessions and organization input are intentionally not part of this route.

`GET /api/v1/signing/documents` uses the same bearer capability to return the ordered Markdown documents from the exact Git revision pinned when the envelope was sent. The database resolves the immutable revision locator; callers cannot supply an envelope, object key, commit, or path. The archive key is re-derived, compressed bytes and gzip output are bounded, SHA-256 and Git HEAD are verified, and no organization or storage identifiers are returned.

Browser links use `/s/{capability}` only as a one-time exchange surface. An active token is encrypted into a purpose-separated, `HttpOnly`, `SameSite=Lax` cookie whose lifetime cannot exceed the durable capability expiry or 30 days, then redirected to the locale-specific clean `/{locale}/sign` URL. The signing page rechecks durable authorization before and after loading the pinned revision, never exposes the raw token to client-side code, and renders only a bounded, server-sanitized Markdown node model. Raw HTML remains visible as escaped text, external images become inert notices, unsafe link schemes are non-interactive, invisible Unicode controls become visible markers, and the exact escaped Markdown source remains available in a separate tab.

`POST /api/v1/signing/viewed` records the first foreground browser view without turning a page `GET` into a mutation. It requires the encrypted recipient cookie, an exact same-origin request, an `Idempotency-Key`, and envelope/recipient IDs that match the freshly resolved cookie context. The recipient transition, optional `sent` to `in_progress` envelope transition, durable command receipt, and `recipient.viewed` audit event publish atomically. Replays are evidence-checked; stale tabs, inactive capabilities, key reuse, and audit-head races fail closed without disclosing whether another recipient session is valid.

`POST /api/v1/signing/decline` is the first terminal recipient decision. Only an active signer or approver can confirm it from the signing page. The capability cookie remains the sole authority, while submitted IDs are equality constraints. Publishing atomically marks the actor and envelope declined, revokes every other issued non-completed recipient capability without forging their status, terminally fails all still-deliverable invitation intents, scrubs their encrypted capability material, stores an evidence-checked command receipt, and appends one PII-free `recipient.declined` audit event with the exact sorted sibling-revocation manifest. Delivered and already-permanent failure evidence is retained. A delivery lease observed before publication returns a retryable conflict without partial writes, preventing a terminal commit from racing a new provider submission. If a D1 lease clears during rollback classification, the conservative fallback is an unavailable response with the cookie preserved; retrying is safe. A successful or safely replayed response clears the terminal browser session.

`POST /api/v1/signing/approve` is a routing-order recipient decision, available only to an active approver who has already viewed the documents. The capability cookie is the sole authority, submitted IDs are equality constraints, and same-origin, a bounded `Idempotency-Key`, `application/json`, and a 4 KiB body cap are all enforced before the cookie is read. Publishing atomically marks the actor `completed`, revokes its capability, and appends a `recipient.approved` audit event. When later signer or approver actions remain once the acting group clears, the same command also releases the next actionable routing group's reserved capabilities and reopens blocked delivery-outbox rows at that order. Viewer and prefill roles do not block workflow completion. When no signer or approver action remains, the command instead completes the envelope and appends a second `envelope.completed` event chained onto the `recipient.approved` event's own hash in the same publication. Only a bounded audit-head race is retried; every other outcome, including a currently inactive capability, is returned as-is. A successful or safely replayed response clears the recipient session cookie; every other outcome leaves it in place.

`POST /api/v1/signing/sign` is the matching one-shot signer completion. The browser posts same-origin with the HttpOnly recipient-session cookie (unsealed only on the server; the raw capability is never exposed as a bearer token), a bounded `Idempotency-Key`, expected envelope/recipient IDs, `expectedFieldGeneration` from the page's field snapshot, and exactly one value per field this recipient owns (including the exact empty set when none are assigned). Typed values are `signature`/`initials` text, free text, real `YYYY-MM-DD` dates, and boolean checkboxes. The request fingerprint is computed after normalization and includes field generation, so value order and surrounding whitespace do not change the digest, a stale page cannot sign after labels or required flags change, and durable replay reconstructs the same digest from stored `field_value` rows. Raw values and labels stay in SQL; audit events and the public receipt carry only value SHA-256 digests. Publishing atomically completes the actor, revokes its capability, inserts immutable field values, and either releases the next routing group or completes the envelope with a chained `recipient.signed` then `envelope.completed` audit pair. Ink capture, PDF sealing, DOCX, webhooks, and rate limits remain out of this slice.

Invitation delivery claims durable outbox rows with bounded leases and stable ordering, reclaims abandoned work, and re-reads the current lease-scoped recipient/envelope/capability projection immediately before decrypting or sending. Claim transactions use a bounded indexed sweep to terminally scrub due or abandoned rows that became ineligible, so recipient or envelope state changes cannot strand encrypted token material. The worker authenticates and hashes the sealed capability before use and sends localized English or Japanese text-and-HTML mail. Provider acceptance atomically marks the row delivered and scrubs ciphertext. Provider configuration/authentication failures and sealing-key drift retain ciphertext for capped backoff; only recipient-scoped rejection, exhausted attempts, or integrity failures become terminal. One item-level database error does not abort its successfully processed siblings. Cloudflare Workers use the native Email Sending binding, while Node/Docker uses its REST adapter. The protected drain response and logs contain only stable delivery IDs, counts, outcomes, and sanitized error codes. The external provider call remains non-transactional; provider acceptance and database completion form an at-least-once boundary, so downstream mail delivery must tolerate rare duplicates after an ambiguous process failure.

The implementation backlog is tracked in [GitHub Issues](https://github.com/d6e-ai/signkit/issues), including DOCX conversion, agent workload credentials and a Rust CLI, enterprise SSO/audit export boundaries, and the lower-priority Vercel production profile.
