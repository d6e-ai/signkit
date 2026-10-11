# Completion access reissue

`POST /api/v1/envelopes/{envelopeId}/recipients/{recipientId}/completion-access/reissue` grants one
recipient a fresh completion-mail access delivery after their prior delivery permanently exhausted
retries (for example, while the completion PDF repaired, or because of a transient mail-provider
outage). It is explicit recovery, never automatic retry: the caller must observe the exact exhausted
generation first, from `GET /api/v1/envelopes/{envelopeId}/completion-deliveries`, and echo it back.

## Append-only successor chain

A reissue never mutates the exhausted predecessor row in `completion_delivery_outbox` -- its status,
attempts, last error, revocation, and scrubbed token stay exactly as the exhausting failure wrote
them. It only appends a new row chained to it by `predecessor_delivery_id`, one `generation` higher.
The "current" generation for a recipient is therefore always "no successor yet, or the newest one."
This mirrors the append-only design of `recipient_capability_reissue` (the analogous recovery for
signing invitations) and the existing D1/PostgreSQL CAS idioms used throughout completion delivery.

Eligibility for reissue is narrow and durable-evidence-only: the envelope must still be `completed`,
the recipient must still hold a completion-delivery-eligible role, and the predecessor must be the
exact generation the caller observed -- `failed`, non-retryable, already revoked, already token-scrubbed,
unleased, and matching the caller's `expectedAttempts`/`expectedFailedAt`/`expectedErrorCode` tuple. A
predecessor that never exhausted (`not_eligible: predecessor_not_exhausted`) or one a concurrent
reissue or repair already superseded (`stale_generation`) is refused with 409, never silently revived.

## Artifact re-verification, not pointer trust

Before granting new access, the completion manifest (JSON + Markdown) and the completion PDF are
independently re-verified against actual object storage bytes -- `CompletionAccessReissueArtifactVerifier`
re-derives each content-addressed object key from the recorded digest, checks the live object metadata,
reads the exact attested size, and recomputes the digest over the real bytes. `CompletionPdfAttachmentReader`
is not reused for the PDF leg: it intentionally stops at `MAX_COMPLETION_MAIL_ATTACHMENT_PDF_BYTES`
(3 MiB) without hashing a larger PDF, since it exists only to decide whether a PDF can be mailed as an
attachment. A reissue must verify the full published PDF, bounded at the publication-time limit (32 MiB).

The exact digests this process observed are carried into the publish command and rechecked again, at
write time, against the current `completion_artifact` / `completion_artifact_pdf` rows -- never against
object storage a second time. A concurrent repair that replaces either artifact between verification and
publication aborts the write (`integrity_error`) rather than granting access to evidence that was never
actually checked.

## Publication

- **D1**: `completion_access_reissue_command` is an append-only receipt table. Its `AFTER INSERT`
  trigger re-checks every predicate (envelope, recipient, predecessor CAS tuple plus "no successor
  yet", audit head, artifact digest match) and, only if all pass, inserts the successor outbox row,
  scrubs the receipt's own copy of the sealed token (it now lives only on the outbox row), inserts the
  `recipient.completion_access_reissued` audit event, and touches the envelope. One D1 statement is
  therefore the whole atomic operation; `D1CompletionAccessReissueStore` never inspects the
  provider-specific abort text and instead reclassifies any failure from durable evidence read back
  afterward (replay, idempotency conflict, stale generation, or integrity error).
- **PostgreSQL**: `PostgresCompletionAccessReissueStore` runs the same predicates inside one
  transaction, locking the envelope row first and then the predecessor row -- matching the
  lock ordering every other envelope-audit writer in this codebase uses, so a concurrent repair or
  reissue serializes correctly instead of racing.

Both stores issue a new `skca1_` token through the existing `AesGcmCompletionTokenSealer` and a
30-day expiry via `computeCompletionAccessExpiry`, reusing the same primitives completion delivery's
initial enrollment uses. No `MailSender` is invoked here: a reissue only enqueues the new generation;
the existing drain (`CompletionDeliveryService.deliverPendingCompletions`) claims and mails it exactly
as it would any other pending delivery.

## Idempotency

`Idempotency-Key` is required and scoped to `(actorType, actorId, idempotencyKey)`. The request hash
covers the full expected-generation tuple, so a safe same-key replay (identical body) returns the
original receipt without minting a new grant, a changed-body same-key request is a 409 idempotency
conflict, and a different key against an already-superseded generation is a 409 stale-generation
conflict. `CompletionAccessReissueService.reissue` resolves replay and eligibility (durable-evidence-only,
no object-storage IO) before doing any manifest/PDF verification or sealing, so an already-ineligible or
already-replayed request never pays for that IO.

## API surface

- `GET /api/v1/envelopes/{envelopeId}/completion-deliveries` (`envelopes:read`): each recipient's
  current generation, status, attempts, expiry/revocation timestamps, the sanitized failure error
  code, and whether that generation is eligible for reissue. Never a token, sealed ciphertext, or
  claim lease.
- `POST /api/v1/envelopes/{envelopeId}/recipients/{recipientId}/completion-access/reissue`
  (`envelopes:send`, or any active instance session member): the explicit recovery command described
  above.

Both accept either a SignKit API key with the listed scope or an operator session cookie, matching
every other envelope-management endpoint's dual-authority pattern.

## What is not built yet

The sender-facing confirmation UI (a shadcn `AlertDialog` surfacing the current failure and
explaining that old access stays revoked while new access lasts 30 days) is not implemented in this
slice -- only the API, stores, migrations, and their tests. The CLI does not expose this command
either. Both are optional follow-up work, not required for the backend recovery path to function.

## Verification

`completion-access-reissue-artifact-verifier.spec.ts` and `completion-access-reissue-service.spec.ts`
cover verification outcomes and the service's replay/eligibility/retry orchestration against fakes.
`d1-completion-access-reissue.integration.spec.ts` (node:sqlite) and
`postgres-completion-access-reissue.integration.spec.ts` (real PostgreSQL, skipped without
`POSTGRES_TEST_URL`) exercise the actual migrated schema and triggers/transactions end to end: publish,
safe replay, changed-body conflict, stale generation, an unexhausted predecessor, an unknown
predecessor, and a write-time artifact-digest mismatch. `route-parity.spec.ts` and
`mutation-schema-drift.spec.ts` keep the OpenAPI document honest against the shipped handlers.
