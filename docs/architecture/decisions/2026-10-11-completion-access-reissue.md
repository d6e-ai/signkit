# Explicit recovery for terminal completion-mail delivery

Date: 2026-10-11
Status: Accepted

## Context

Completion-mail delivery (`completion_delivery_outbox`) retries a bounded number of times and then
terminally fails: the grant is revoked, the sealed token is scrubbed, and the row is left `failed`,
non-retryable. That is correct when the real cause is permanent (an invalid recipient address), but
some exhausting causes are themselves transient and get fixed later -- the completion PDF finishes a
repair, or a mail-provider outage clears. Once exhausted, no existing mechanism re-grants that
recipient access; the only recourse was a manual database write.

## Decision

- Model recovery as an append-only successor chain on the existing outbox table, not a revival of
  the exhausted row. `completion_delivery_outbox` gains `generation` and `predecessor_delivery_id`;
  a reissue inserts one new generation chained to the exhausted one and never touches that row's
  status, attempts, error, revocation, or scrubbed token. This preserves the original failure as
  durable evidence and keeps the delivery claim/retry machinery (which only ever sees "the current
  generation") unchanged.
- Require the caller to observe and echo the exact exhausted generation
  (`expectedDeliveryId`/`expectedAttempts`/`expectedFailedAt`/`expectedErrorCode`) plus an explicit
  `grantAccess: true`. There is no "reissue whatever is currently failed" command: a stale or
  ambiguous view of the delivery history can never silently reissue the wrong generation, and a
  concurrent second reissue or repair is caught as `stale_generation`.
- Use terminal state, not an exhaustion counter, as the eligibility boundary. The latest failed
  delivery must be non-retryable, revoked, token-scrubbed, unleased, and match the observed tuple.
  This includes exhausted retries, permanent rejection, and expired-grant cleanup. The operator
  resolves the underlying cause; reissue never restores the old grant or edits recipient identity.
- Preserve a bounded failure cause separately from the generic exhaustion classification for new
  terminal failures. Historical lost causes remain unknown; never reconstruct them from other
  fields. The operator status API/UI exposes that distinction without tokens or provider messages.
- Independently re-verify the completion manifest and PDF against actual object storage bytes
  immediately before granting new access, rather than trusting the `completion_artifact` /
  `completion_artifact_pdf` database pointers. The existing `CompletionPdfAttachmentReader` cannot be
  reused for this: it deliberately stops hashing a PDF past the 3 MiB mail-attachment bound. A
  dedicated verifier reads up to the full 32 MiB publication bound instead.
- Publish atomically per backend: a D1 `AFTER INSERT` trigger re-checks every predicate (including
  the artifact digests this process just verified) and performs the insert/scrub/audit in the same
  statement; PostgreSQL runs the same predicates and writes inside one transaction, locking the
  envelope before the predecessor row, matching this codebase's existing lock ordering for
  envelope-audit writers. Same-key requests waiting on that lock resolve the committed receipt
  before eligibility, so serialization does not turn an idempotent replay into a stale conflict.
- Never invoke `MailSender` from the reissue path. It only enqueues the new generation; the existing
  retryable drain claims and mails it exactly as any other pending delivery.

## Consequences

A recipient whose completion mail exhausted for a now-resolved cause can be explicitly, auditably
re-granted access without a manual database write or ever reviving the original (now permanently
revoked) grant. The audit chain gains one `recipient.completion_access_reissued` event per reissue,
anchored to the envelope's existing hash chain; no historical audit event is rewritten.

This adds one receipt table and a small amount of per-backend duplication (the D1 trigger and the
PostgreSQL transaction both encode the same predicates) rather than a single shared implementation --
consistent with how every other D1/PostgreSQL command pair in this codebase is built, since D1 has no
real multi-statement transaction with row locks to share logic with.

The completed-envelope Documents tab now surfaces this recovery directly: a token/key-free read of
each recipient's current generation, a "Grant new access" action gated on the server's own
`eligibleForReissue` bit, and an `AlertDialog` that states the new link lasts 30 days and the old one
stays revoked. It mints and preserves one `Idempotency-Key` per exhausted generation (keyed by that
generation's own delivery ID, which is itself CAS-stable) across ambiguous retries, and reports
acceptance/queuing rather than delivery, since the drain sends asynchronously and this command never
calls `MailSender`. CLI exposure remains deliberately out of scope, matching every other
session-oriented recovery command (`docs/architecture/agent-contract.md`).

## Alternatives considered

- **Reset the exhausted row back to `pending` in place:** rejected because it destroys the original
  failure as evidence and reintroduces the row into claim/retry machinery that assumes a `failed`
  non-retryable row is terminal.
- **Trust the completion-artifact database pointer at reissue time without re-reading object
  storage:** rejected because a pointer can reference an object a concurrent repair has already
  replaced or that never actually matches its recorded digest; granting access on pointer trust alone
  would hand out a link to unverified evidence.
- **Let the caller reissue "whatever is currently exhausted" without echoing the observed
  generation:** rejected because it cannot distinguish a stale read from the current state and would
  make a duplicate or late request unsafe to retry.
