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

The first agent-facing endpoints are `POST /api/v1/envelopes`, `GET /api/v1/envelopes`, `GET /api/v1/envelopes/{envelopeId}`, `GET /api/v1/envelopes/{envelopeId}/draft`, `POST /api/v1/envelopes/{envelopeId}/draft/commits`, `POST /api/v1/envelopes/{envelopeId}/ready`, `POST /api/v1/envelopes/{envelopeId}/fields`, `POST /api/v1/envelopes/{envelopeId}/send`, `POST /api/v1/envelopes/{envelopeId}/void`, and `GET /api/v1/envelopes/{envelopeId}/deliveries`. Mutations require an authenticated d6e-auth organization and an `Idempotency-Key` header. Draft commits use expected-generation concurrency and optional automation provenance. The ready command supplies the expected Git generation plus a complete recipient graph: signer and approver are action-bearing, viewer is read-only and must share an order with an action-bearing recipient, prefill remains pre-send-only and is rejected until its authoring command exists, and CC stays outside the capability graph. Send pins the Git commit, reserves capabilities and durable delivery intents only for signer, approver, and viewer recipients, and activates the first actionable order with its co-routed viewers. Later groups stay blocked. The same key and normalized request replay the original receipt; key reuse or stale state returns an RFC 9457 conflict. Responses keep storage keys, archive bytes, capabilities, hashes, ciphertext, and outbox IDs internal.

`POST /api/v1/envelopes/{envelopeId}/fields` is an idempotent replace-all signing-field placement command, usable only while an envelope is `ready`, before it is sent. The body supplies `expectedGeneration` (the Git generation), `expectedFieldGeneration` (a compare-and-set counter for the field set itself), and 1-50 fields, each naming a recipient, a `documents/*.md` path, a `fieldType` (`signature`, `initials`, `text`, `date`, or `checkbox`), a label, whether it is required, and a semantic document-order `position`; there is no page/x/y geometry in this slice. Only signer recipients in the same organization and envelope may own a field, and every document path must exist in the exact bounded Git workspace pinned by `expectedGeneration`. Field IDs are derived deterministically from the recipient, document path, field type, and position, so replacing the set with the same declarations reproduces the same IDs. Publishing atomically rechecks generation, Git head, field generation, envelope state, and recipient scope; replaces the complete field projection; increments `expectedFieldGeneration`; and appends one PII-minimized `envelope.fields_placed` audit event. Cloudflare enforces this atomically with a rollback-on-failed-predicate D1 trigger; PostgreSQL uses ordered row locking (envelope, then referenced recipients sorted by ID) inside one transaction. The response never echoes labels, audit hashes, archive/storage identifiers, emails, names, or internal command IDs.

`GET /api/v1/signing/context` is the separate public-recipient boundary. It accepts only a `Bearer` recipient capability, requires a non-revoked future expiry and actionable recipient/envelope state in the database query, and returns a minimal allowlisted context. Missing, malformed, unknown, expired, revoked, blocked, and inactive capabilities share one not-found response. Operator OAuth sessions and organization input are intentionally not part of this route.

`GET /api/v1/signing/documents` uses the same bearer capability to return the ordered Markdown documents from the exact Git revision pinned when the envelope was sent. The database resolves the immutable revision locator; callers cannot supply an envelope, object key, commit, or path. The archive key is re-derived, compressed bytes and gzip output are bounded, SHA-256 and Git HEAD are verified, and no organization or storage identifiers are returned.

Browser links use `/s/{capability}` only as a one-time exchange surface. An active token is encrypted into a purpose-separated, `HttpOnly`, `SameSite=Lax` cookie whose lifetime cannot exceed the durable capability expiry or 30 days, then redirected to the locale-specific clean `/{locale}/sign` URL. The signing page rechecks durable authorization before and after loading the pinned revision, never exposes the raw token to client-side code, and renders only a bounded, server-sanitized Markdown node model. Raw HTML remains visible as escaped text, external images become inert notices, unsafe link schemes are non-interactive, invisible Unicode controls become visible markers, and the exact escaped Markdown source remains available in a separate tab.

`POST /api/v1/signing/viewed` records the first foreground browser view without turning a page `GET` into a mutation. It requires the encrypted recipient cookie, an exact same-origin request, an `Idempotency-Key`, and envelope/recipient IDs that match the freshly resolved cookie context. The recipient transition, optional `sent` to `in_progress` envelope transition, durable command receipt, and `recipient.viewed` audit event publish atomically. Replays are evidence-checked; stale tabs, inactive capabilities, key reuse, and audit-head races fail closed without disclosing whether another recipient session is valid.

`POST /api/v1/signing/decline` is the first terminal recipient decision. Only an active signer or approver can confirm it from the signing page. The capability cookie remains the sole authority, while submitted IDs are equality constraints. Publishing atomically marks the actor and envelope declined, revokes every other issued non-completed recipient capability without forging their status, terminally fails all still-deliverable invitation intents, scrubs their encrypted capability material, stores an evidence-checked command receipt, and appends one PII-free `recipient.declined` audit event with the exact sorted sibling-revocation manifest. Delivered and already-permanent failure evidence is retained. A delivery lease observed before publication returns a retryable conflict without partial writes, preventing a terminal commit from racing a new provider submission. If a D1 lease clears during rollback classification, the conservative fallback is an unavailable response with the cookie preserved; retrying is safe. A successful or safely replayed response replaces the active browser capability with a purpose-separated encrypted terminal-receipt cookie. Reloads and the original `/s/{capability}` link revalidate the stored command, audit event, immediate audit predecessor, and current terminal projection before returning only envelope/recipient IDs, declined statuses, timestamp, and locale. The receipt expires at `declinedAt + 30 days`; it cannot read Git/object storage or call recipient mutations, and invalid, stale, superseded, or drifted evidence fails closed.

`POST /api/v1/envelopes/{envelopeId}/void` gives an authenticated organization operator the matching terminal command for `draft`, `ready`, `sent`, and `in_progress` envelopes. Required expected status and Git generation values prevent a stale automation or confirmation page from voiding a concurrently changed envelope. One D1 trigger or PostgreSQL transaction fences active delivery leases, terminally scrubs still-deliverable invitation ciphertext, revokes every issued non-completed capability without changing recipient statuses, moves the envelope to `voided`, stores an exact command receipt, and appends a PII-free `envelope.voided` event. Replay rehashes the receipt and audit chain and verifies the current terminal projection; provider-accepted messages and existing permanent evidence remain unchanged.

`POST /api/v1/signing/approve` is a routing-order recipient decision, available only to an active approver who has already viewed the documents. Publishing atomically marks the actor `completed`, revokes its capability, and appends `recipient.approved`. When later actions remain, it releases the next signer/approver order and its co-routed viewers. When no action remains, it fences active invitation leases, terminally scrubs remaining deliverable ciphertext, revokes outstanding non-completed capabilities without fabricating recipient decisions, completes the envelope, and appends a chained `envelope.completed` event. Delivery leases return a retryable conflict with no partial write or cookie clearing. Exact replays remain evidence-checked.

`POST /api/v1/signing/sign` is the matching one-shot signer completion. The browser posts same-origin with the HttpOnly recipient-session cookie, a bounded `Idempotency-Key`, expected envelope/recipient IDs, `expectedFieldGeneration`, and exactly one typed value per owned field. Raw values stay only in SQL; audit and public receipts carry digests. Publishing atomically completes the actor, stores immutable values, and either releases the next action-bearing group with its co-routed viewers or performs the same lease-fenced terminal cleanup and chained `recipient.signed` then `envelope.completed` audit pair. Ink capture, PDF sealing, DOCX, webhooks, and rate limits remain out of this slice.

Invitation delivery claims durable outbox rows with bounded leases and stable ordering, reclaims abandoned work, and re-reads the current lease-scoped recipient/envelope/capability projection immediately before decrypting or sending. Claim transactions use a bounded indexed sweep to terminally scrub due or abandoned rows that became ineligible, so recipient or envelope state changes cannot strand encrypted token material. The worker authenticates and hashes the sealed capability before use and sends localized English or Japanese text-and-HTML mail. Provider acceptance atomically marks the row delivered and scrubs ciphertext. Provider configuration/authentication failures and sealing-key drift retain ciphertext for capped backoff; only recipient-scoped rejection, exhausted attempts, or integrity failures become terminal. One item-level database error does not abort its successfully processed siblings. Cloudflare Workers use the native Email Sending binding, while Node/Docker uses its REST adapter. The protected drain response and logs contain only stable delivery IDs, counts, outcomes, and sanitized error codes. The external provider call remains non-transactional; provider acceptance and database completion form an at-least-once boundary, so downstream mail delivery must tolerate rare duplicates after an ambiguous process failure.

The implementation backlog is tracked in [GitHub Issues](https://github.com/d6e-ai/signkit/issues), including DOCX conversion, agent workload credentials and a Rust CLI, enterprise SSO/audit export boundaries, and the lower-priority Vercel production profile.
