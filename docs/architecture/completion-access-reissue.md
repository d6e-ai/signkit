# Completion access reissue

`POST /api/v1/envelopes/{envelopeId}/recipients/{recipientId}/completion-access/reissue` grants one
recipient a fresh completion-mail access delivery after their prior delivery terminally failed
(for example, after exhausting retries while the completion PDF repaired or during a mail-provider
outage). It is explicit recovery, never automatic retry: the caller must observe the exact failed
generation first, from `GET /api/v1/envelopes/{envelopeId}/completion-deliveries`, and echo it back.

## Append-only successor chain

A reissue never mutates the terminal predecessor row in `completion_delivery_outbox` -- its status,
attempts, last error, revocation, and scrubbed token stay exactly as the original failure wrote
them. It only appends a new row chained to it by `predecessor_delivery_id`, one `generation` higher.
The "current" generation for a recipient is therefore always "no successor yet, or the newest one."
This mirrors the append-only design of `recipient_capability_reissue` (the analogous recovery for
signing invitations) and the existing D1/PostgreSQL CAS idioms used throughout completion delivery.

Eligibility for reissue is narrow and durable-evidence-only: the envelope must still be `completed`,
the recipient must still hold a completion-delivery-eligible role, and the predecessor must be the
exact generation the caller observed -- `failed`, non-retryable, already revoked, already token-scrubbed,
unleased, and matching the caller's `expectedAttempts`/`expectedFailedAt`/`expectedErrorCode` tuple. A
predecessor that is still retryable (`not_eligible: predecessor_not_terminal`) or one a concurrent
reissue or repair already superseded (`stale_generation`) is refused with 409, never silently revived.

Eligibility deliberately covers all terminal failures, not only a fixed attempt count or an
exhaustion error code: permanent recipient rejection and expired-grant cleanup also qualify when
all the predicates above hold. The operator must resolve the underlying cause before confirming;
reissue does not correct an address or fix a mail provider. An expired predecessor is not renewed:
its revocation and expiry remain unchanged, and the successor gets its own fresh expiry.

## Artifact re-verification, not pointer trust

Before granting new access, the completion manifest (JSON + Markdown) and the completion PDF are
independently re-verified against actual object storage bytes -- `CompletionAccessReissueArtifactVerifier`
re-derives each content-addressed object key from the recorded digest, checks the live object metadata,
reads the exact attested size, and recomputes the digest over the real bytes. `CompletionPdfAttachmentReader`
is not reused for the PDF leg: it intentionally stops at `MAX_COMPLETION_MAIL_ATTACHMENT_PDF_BYTES`
(3 MiB) without hashing a larger PDF, since it exists only to decide whether a PDF can be mailed as an
attachment. A reissue must verify the full published PDF, bounded at the publication-time limit (32 MiB).
The independently repairable PDF pointer must also equal that digest's canonical object key;
a wrong stored pointer is rejected before storage is read. JSON and Markdown are insert-only
publication records and their serving readers derive the same canonical keys from the digests.

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
  reissue serializes correctly instead of racing. The durable receipt is resolved again after
  acquiring that lock, before returning an eligibility failure, so a same-key request queued behind
  its original publication replays instead of spuriously returning a stale-generation conflict.
  Failure classification uses durable receipt/CAS/audit evidence, not provider error text; an
  unexpected database error with an unchanged audit head is rethrown, not disguised as a race.

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
  current generation, status, attempts, expiry/revocation timestamps, `errorCode`, the separate
  nullable `failureCauseCode`, and whether that generation is eligible for reissue. Never a token,
  sealed ciphertext, object key, or claim lease. An unknown envelope is 404; an existing envelope
  with no completion deliveries returns an empty list.
- `POST /api/v1/envelopes/{envelopeId}/recipients/{recipientId}/completion-access/reissue`
  (`envelopes:send`, or any active instance session member): the explicit recovery command described
  above.

Both accept either a SignKit API key with the listed scope or an operator session cookie, matching
every other envelope-management endpoint's dual-authority pattern.

`failureCauseCode` preserves a bounded, sanitized cause when a new terminal failure would otherwise
replace `errorCode` with `delivery_attempts_exhausted`. The automatic expiry/ineligibility cleanup
records `delivery_not_eligible` for future failures. Historical rows whose causes were overwritten
remain `null` (unknown); no migration guesses a cause from the exhaustion classification. SQL
constraints enforce the same safe code shape and sensitive-token-prefix exclusions as the writer.

## Operator UI

The completed-envelope Documents tab reads `completion-deliveries` (token/key-free) alongside the
existing completion-artifact status whenever the envelope is `completed`, and renders each
recipient's current generation, status, recorded failure cause (or explicitly unknown), and access
expiry. A recipient whose current generation is
`failed` and `eligibleForReissue` gets a "Grant new access" action; a `failed` row that is not yet
eligible (still within its own retry budget) shows the action disabled with an explanation instead of
hiding it. Confirming opens a shadcn `AlertDialog` that states plainly that the new link lasts 30 days
and the old link stays revoked and unusable -- it never implies the old grant is restored.

The page sends back the exact `expectedDeliveryId`/`expectedAttempts`/`expectedFailedAt`/`expectedErrorCode`
tuple it last observed for that row, captured when the dialog opened, never a value re-read at confirm
time. The mutation attempt (and its `Idempotency-Key`) is keyed by that terminal generation's own
delivery ID, so an ambiguous network failure, cancel-and-reopen, or disconnect-and-retry replays the
same key and body; a newer terminal generation is a different delivery ID and therefore always a
fresh key, never a reused one. A successful response reports the request as accepted and queued for
delivery, not delivered -- the drain sends asynchronously, and this command never invokes `MailSender`
itself, so a page reload or a completion-artifact PDF repair happening to run around the same time
can never by itself enqueue mail. On success the page re-reads `completion-deliveries`; a failed
re-read shows a separate warning alongside the success notice without implying the grant failed.

The client allowlists the receipt (envelope, recipient, delivery, generation, expiry, timestamp) and
validates it structurally before trusting it, exactly like the existing recipient-capability-reissue
client. The system capabilities endpoint (`GET /api/v1/system/capabilities`) advertises both endpoints
under `completionAccessReissue`, and the `envelopes:read`/`envelopes:send` API-key scope lists include
them, so an agent integrator can discover this surface the same way it discovers every other endpoint.

## What is not built

The Rust CLI does not expose this command; it remains an operator-UI/API-only surface, matching how
capability reissue and other session-oriented recovery commands are deliberately not exposed to the
CLI (see `docs/architecture/agent-contract.md`).

## Verification

`completion-access-reissue-artifact-verifier.spec.ts` and `completion-access-reissue-service.spec.ts`
cover verification outcomes and the service's replay/eligibility/retry orchestration against fakes.
`d1-completion-access-reissue.integration.spec.ts` (node:sqlite) and
`postgres-completion-access-reissue.integration.spec.ts` (real PostgreSQL, skipped without
`POSTGRES_TEST_URL`) exercise the actual migrated schema and triggers/transactions end to end: publish,
safe replay, changed-body conflict, stale generation, a still-retryable predecessor, an unknown
predecessor, a write-time artifact-digest mismatch, an audit-head race that aborts and rolls back the
whole write with no partial outbox/audit/command row, and receipt replay continuing correctly after
the successor's own ciphertext is resealed under a rotated key and later itself exhausts and is
scrubbed. `completion-access-reissue.spec.ts` and `completion-access-reissue-status.spec.ts` cover the
HTTP layer: session/API-key authorization and scope (including a read-only key forbidden to mutate and
an inactive/suspended member), strict body and `Idempotency-Key` requirements, and every outcome's
problem response. `completion-delivery-service.reissue-generation.spec.ts` drains a reissued
generation through the real `NodemailerSmtpMailSender` and Cloudflare binding/REST `MailSender`
adapters (not the generic test double used elsewhere), proving only the new grant's token ever reaches
a provider and that a real provider failure fails closed on that generation alone -- the drain has no
notion of a predecessor to revive. `page.completion-access-reissue.browser.spec.ts` exercises the
actual rendered UI: visibility/disabled states, the confirmation dialog's wording, idempotency-key and
CAS-tuple preservation across an ambiguous failure, 409-outcome-specific messaging, and the
queued-not-delivered success wording with a distinct post-success refresh-failure warning.
`route-parity.spec.ts` and `mutation-schema-drift.spec.ts` keep the OpenAPI document honest against the
shipped handlers.

`postgres-completion-access-reissue-concurrency.integration.spec.ts` uses real PostgreSQL lock waits
to force two same-key and distinct-key publications into the same window. The separate audit-integrity
suite checks the post-completion chain and webhook subscription catalog while preserving the anchored
completion proof byte-for-byte. Contract/pointer/failure-cause specs cover concrete OpenAPI response
shapes, timestamp precision, unknown-envelope reads, wrong PDF pointers, historical unknown causes,
and bounded future failure codes.

The PostgreSQL suites require `POSTGRES_TEST_URL`; a skipped suite is not evidence of PostgreSQL
behavior. The repository's node:sqlite D1 suites are migration/SQL harnesses, not actual D1 runtime
coverage. The parent validation additionally exercises migration upgrade, atomic publication,
rollback, and receipt replay in disposable local workerd D1. These local checks do not prove live
Workers resource limits, authenticated product E2E, or real email delivery: provider tests use mocked
SMTP transports and Cloudflare bindings/REST responses, and no live recipients are contacted.
