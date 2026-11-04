# Completion delivery

Completion artifact delivery notifies agreement participants when an envelope completes and
distributes purpose-separated read grants for the immutable completion artifact.

Artifact publication (Slice A) is a strict prerequisite: a periodic reconciliation worker discovers
`completed` envelopes only after their completion artifact has been successfully published to object
storage and recorded in the database. Envelopes lacking a published artifact are excluded from
discovery and cannot enroll deliveries.

Delivery targets all participants in the completed agreement: `signer`, `approver`, `viewer`, and
`cc` recipients are eligible for completion delivery. `prefill` recipients are strictly excluded, as
prefill is pre-send authoring metadata and plays no role in post-completion artifact distribution.
Each eligible recipient is enrolled exactly once in a dedicated `completion_delivery_outbox` table,
guarded by a `UNIQUE(envelope_id, recipient_id)` constraint and foreign keys to both
`completion_artifact` and `recipient`.

Each enrolled recipient receives a high-entropy 32-byte `skca1_` access token grant. These grants
are strictly purpose-separated: they convey read-only access to the published completion artifact,
carry no signing or approval authority, cannot mutate any envelope state, and never mint or interact
with browser session cookies. Grants carry an immutable 30-day lifetime
(`access_expires_at = enrolled_at + 30 days`). When queried after expiration or after access has
been revoked, the service returns an opaque RFC 9457 404 not-found response, indistinguishable from
an unknown token, to prevent token enumeration or status oracle leakage.

Delivery is managed through a dedicated `completion_delivery_outbox` table, completely separated
from the invitation `delivery_outbox`. Claiming follows a bounded-batch (at most 25 items per
claim), stable-ordering, five-minute lease-reclaim, and capped exponential backoff (up to 10
attempts) pattern. The worker re-reads the current lease-scoped recipient/envelope projection
immediately before decrypting token ciphertext and dispatching email. As with invitation delivery,
external mail dispatch (`SIGNKIT_MAIL_PROVIDER=cloudflare`: the native Email Sending binding on
Cloudflare Workers, its REST API on Node/Docker and Vercel; `SIGNKIT_MAIL_PROVIDER=smtp`: the
Nodemailer SMTP adapter on every runtime, with Workers rejecting prohibited port 25) is
non-transactional with respect to database updates; provider acceptance and database update form an
at-least-once boundary, so downstream mail recipients must tolerate rare duplicates resulting from
ambiguous process failures.

Ciphertext lifecycle and terminal failure semantics enforce least privilege:

- Upon successful delivery (provider acceptance), the sealed token ciphertext is scrubbed to `NULL`
  in the database, while the access grant remains active (`access_revoked_at IS NULL`) for the
  remainder of its 30-day lifetime.
- Upon permanent terminal failure (e.g. invalid recipient address, attempt exhaustion, or ciphertext
  digest mismatch), the sealed token ciphertext is scrubbed to `NULL` and access is terminally
  revoked by recording `access_revoked_at = now()`.
- Upon retryable failure (e.g. rate limits or transient mail transport errors), the sealed token is
  retained for exponential backoff retry and access remains active (`access_revoked_at IS NULL`).

Public artifact retrieval is exposed over two unauthenticated public boundaries requiring no
cookies, sessions, or d6e-auth credentials:

- `GET /api/v1/completion-artifacts`: Accepts an `skca1_` token via `Authorization: Bearer <token>`
  and defaults to JSON (`application/json`).
- `GET /c/{token}`: Direct browser/link access accepting the token as a URL path parameter and
  defaulting to Markdown (`text/markdown; charset=utf-8`).
- `GET /c/{token}/view`: Read-only receipt landing page used by completion mail. It returns no
  token, digest, object key, or recipient data in page data and links back to the same grant-scoped
  raw endpoint for each download. The raw endpoints support an explicit `?format=json`,
  `?format=markdown`, or `?format=pdf` query parameter. The resolver validates token structure and
  SHA-256 hash against the delivery grant and retrieves the matching object from immutable storage
  after verifying the recorded digest. JSON and Markdown are gzip-compressed text artifacts that are
  decompressed under a bounded byte budget; `pdf` returns verified `application/pdf` bytes from
  `completion_artifact_pdf` (D1 `0035_completion_artifact_pdf.sql`, Postgres
  `0033_completion_artifact_pdf.sql`) and is opaque 404 when that row has not been published.
  Unknown, expired, revoked, and wrong-purpose grants share the same receipt state; storage and
  integrity failures expose only a generic unavailable state. Storage bucket keys, instance
  identifiers, recipient identities, and internal metadata are never reflected in the response or
  error bodies.

Published artifacts in object storage and SQL pointer records in `completion_artifact` and
`completion_delivery_outbox` are retained while SQL still references them. Unreferenced object-store
uploads (failed CAS leftovers, not live pointers) are reclaimed by the bounded orphan sweep after a
24-hour grace period. Operator revocation UI remains deferred; explicit instance-seal request,
processing, validation, atomic publication, and authenticated download are described in
[PDF sealing](pdf-sealing.md).

Node/Docker and Cloudflare Workers runtime profiles are fully supported; Vercel uses the existing
PostgreSQL and S3-compatible path. Host schedulers invoke the protected
`POST /api/v1/system/completion-deliveries/drain` endpoint using constant-time
`DELIVERY_WORKER_SECRET` bearer validation; Cloudflare Workers drain completion deliveries
in-process within `scheduled()` via `context.waitUntil` following invitation and completion artifact
drains.

### Mailed PDF attachment

Completion mail attaches the immutable published PDF, not a new render or a draft.
`CompletionPdfAttachmentReader` resolves only the claimed envelope through
`CompletionArtifactPdfStore` and `ObjectStore`: it checks the persisted envelope ID, derives the
content-addressed key, validates recorded and object metadata, reads exactly the bounded size, and
recomputes SHA-256 before attaching bytes.

- Missing publication, storage configuration, or a temporary read failure uses the existing bounded
  retry/backoff. A missing or null reader cannot silently send link-only mail.
- Envelope, key, digest, or size inconsistencies fail closed as `integrity_failed`, with no mail
  sent.
- A verified object above the 3 MiB raw-PDF budget is the sole link-only fallback. JA/EN copy
  explains the size limit and provides the existing expiring secure link. Smaller verified PDFs are
  attached as `signkit-completed-{envelopeId}.pdf`.

The budget leaves headroom for base64 expansion and MIME overhead under Cloudflare's general 5 MiB
message limit. Its 25 MiB exception requires a verified **destination** address, not merely a
verified sender or domain, so arbitrary completion recipients cannot rely on it. See
[Cloudflare Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/).

D1/R2 and PostgreSQL/S3 use the same reader ports, without new migrations or secrets. Mail provider
selection remains independent of the host: SMTP uses a byte-preserving Nodemailer `Buffer`,
Cloudflare Workers bindings use a right-sized `ArrayBuffer`, and Cloudflare REST uses base64. All
preserve nonzero-offset byte views.

Mail transport and provider failure classification follow [mail delivery](mail-delivery.md).
Terminal-delivery recovery requires [completion access reissue](completion-access-reissue.md).
