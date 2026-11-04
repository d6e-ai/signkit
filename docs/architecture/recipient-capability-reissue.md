# Recipient capability reissue

This replaces a signing invitation, not a terminal completion grant. For terminal mail recovery, use
[completion access reissue](completion-access-reissue.md).

Recipient capability reissue is implemented via
`POST /api/v1/envelopes/{envelopeId}/recipients/{recipientId}/reissue` (and
`POST /api/v1/envelopes/{envelopeId}/reissue`). It satisfies the following normative rules governing
the issuance ledger, delivery worker, and view-continuation semantics so that reissuing never
silently redefines what a "capability" or a "view" means.

A recipient is one stable identity for the life of an envelope. Reissuing invitation delivery to
that recipient — because a link expired, delivery failed terminally, or an operator asks to resend —
never creates a new recipient or a new envelope-recipient graph entry; it produces a new capability
for the existing recipient row. Capabilities for one recipient form an append-only lineage: each new
capability records the specific predecessor it supersedes, and at most one capability in that
lineage is ever live — resolvable, non-revoked, non-expired — at a time. Superseding the old
capability and minting the replacement happen atomically; there is no window where two capabilities
for the same recipient both resolve.

The first-view evidence recorded in `recipient_viewed_command` and the `recipient.viewed` audit
event is immutable and permanently bound to the capability that actually performed that first view.
Reissuing a capability never rewrites, re-attributes, or duplicates this evidence, and reissuing is
never itself a second view: it is a separate, repeatable operator command with its own audit event.
That event follows the same PII- and secret-minimization discipline as every other event in this
contract: its public payload may include only the recipient ID, a stable reason code, and
timestamps, plus existing non-secret workflow metadata already carried by comparable events where
essential; it must never contain raw tokens, capability hashes or other capability identifiers,
ciphertext, key IDs, or delivery/outbox IDs. Distinguishing the historical capability that performed
the first view from the capabilities that later superseded it is the job of the immutable command
receipt and the issuance ledger — both server-side, non-public records — never the public audit
payload.

A newly issued capability may be treated as continuing a previously viewed recipient — meaning the
browser can proceed toward signing without repeating `POST /api/v1/signing/viewed` side effects —
only when the durable issuance ledger proves an unbroken lineage from the historical capability that
recorded `recipient_viewed_command` through every intermediate supersession to the capability
currently presented. Lineage continuation is never an assumed replay and never silently granted; it
must be positively proven from the issuance ledger on every request, not cached or inferred from
cookie state alone.

View continuation is classified only after checking capability liveness:

| Presented capability / evidence                                                                     | Outcome                                                               |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Unknown, revoked, or capability-expired with no live successor                                      | Existing opaque `not_found`                                           |
| Live capability for a recipient not yet viewed                                                      | Ordinary first view or its safe idempotency replay                    |
| Live capability for an already-viewed recipient with invalid same-capability command/audit evidence | `integrity_error`                                                     |
| Current live successor with no proven lineage to the recorded view                                  | `integrity_error`                                                     |
| Live successor with verified lineage to the recorded view                                           | Continuation: no second `recipient.viewed` event and no replay marker |

Lineage continuation is recorded distinctly from idempotency-key replay and must never be conflated
with it. Exact-key replay of `POST /api/v1/signing/viewed` remains scoped only to the literal
capability and idempotency key that produced the original `recipient.viewed` event and is unaffected
by reissue. As established above, the distinction between the capability that actually viewed and
the capabilities later reissued lives only in the immutable command receipt and issuance ledger,
never in the public `recipient.capability_reissued` payload.

Recipient-session cookies are envelope-scoped: the cookie name embeds the UUIDv7 envelope ID
(`signkit_recipient_{envelopeId}`), so two envelopes opened in separate tabs coexist and reload
independently. Reissue of the same recipient still shares that envelope's one cookie rather than
minting a second cookie or a per-tab session for that envelope, matching the `/s/<token>` model.
HTTP cookies have no value-conditional delete: a `Set-Cookie` deletion for a given name and path
always clears whatever the browser currently has stored under that name, regardless of which token
the response-generating request itself read when it decided to delete. With one shared cookie name
_per envelope_, a late-arriving denial response for a now-superseded token (H1) can therefore delete
a cookie that a different, concurrent exchange of the replacement link (H2) already wrote for that
same envelope, purely because of response arrival order — the two requests never coordinate, and the
deletion is unconditional at the transport layer no matter how correctly the server-side check that
produced it was scoped. A terminal or failed exchange for envelope A never names envelope B's
cookie, so it cannot disturb a second tab. The only way to remove the same-envelope race is for
every non-terminal recipient surface to become overwrite-only in the same atomic slice that ships
reissue: invalid, unknown, expired, revoked, or superseded tokens, and every `not_found`,
`context_mismatch`, `integrity_error`, and `unavailable` response, must emit no `Set-Cookie`
deletion at all. An inactive cookie is left inert rather than actively cleared — presenting it still
fails closed on durable re-resolution every time regardless of whether it was ever deleted — and it
is retired only by its own bounded `maxAge` (the existing capability-expiry/30-day cap) elapsing, or
by being wholesale overwritten once its holder completes a genuinely valid `/s` exchange for that
envelope. Visiting a superseded `/s/{oldToken}` link must therefore never delete an existing cookie;
only a successful, valid exchange overwrites the same envelope-scoped cookie name and path, which is
safe because writing a known-good value never depends on first verifying what was previously stored.
The reissue operator command itself writes no recipient cookie at all; only a subsequent
recipient-initiated `/s` exchange ever does. Because the cookie for one envelope is shared across
tabs of that envelope rather than scoped to one tab, a stale tab that has not itself exchanged any
link can still observe a live replacement cookie on its very next request purely because a different
tab already completed that exchange; that request must lineage-continue exactly as defined above
rather than being treated as suspicious.

Terminal recipient responses are decline, approve, and sign; operator void is a separate
active-instance-member command that revokes capabilities in the database but never holds or mutates
the recipient browser cookie itself. Decline, approve, or sign completion may still deliberately
expire or exchange only that envelope's active session cookie, including the declined `/s`
cross-name swap that sets a separate envelope-scoped decline-receipt cookie and deletes a same-token
live cookie. This remains safe only because reissue is defined above to reject already-`declined`
and `completed` recipients: a terminal transition and a competing reissue can therefore never be
issuing cookies for the same recipient at the same time, so there is no concurrent write for a
terminal deletion or exchange to race against. If that precondition is ever relaxed so reissue can
target a terminal recipient, every terminal surface must first become overwrite-only in the same way
as the non-terminal surfaces above, before that relaxation ships. Active `/s` must not delete a
same-envelope decline-receipt cookie. Terminal decline is irreversible, so there is no legitimate
active-after-declined state. A live `/s` that already resolved can race a concurrent decline that
has already persisted the receipt: the late `/s` response would then delete that receipt while
setting an already-invalid live cookie. Leaving an old receipt cookie alongside an active cookie is
safe: page load tries active durable authorization first and falls back to the receipt if that
cookie is invalid. Exchanging envelope A never names envelope B's cookies.

Reissue eligibility must not conflate envelope-level terminal expiry with capability-level expiry,
which are different things today. An envelope already in its own terminal `expired` state is
rejected for reissue exactly like `voided` and `completed`, the same as every other
still-deliverable invitation intent. Capability expiry is unrelated: every capability carries its
own expiry timestamp, and a recipient whose most recent capability has simply expired while the
recipient itself remains `pending` or `viewed` inside a `sent` or `in_progress` envelope is
precisely the primary case reissue exists to serve, and must remain eligible. `pending` or `viewed`
plus `sent` or `in_progress` is necessary but not sufficient, though: a recipient in a later,
not-yet-released routing group is also `pending` with a reserved capability, but that capability was
never activated — its durable `recipient.capability_expires_at` is still `NULL` and its outbox row
is still `blocked` — precisely because release, not reissue, is what turns a blocked future-routing
reservation into a live, expiring link. Reissue therefore additionally requires that the targeted
recipient has been released at least once: durable `recipient.capability_expires_at IS NOT NULL`,
whether that expiry is now in the future or already in the past, and the invitation it would
supersede is not merely a blocked, reserved future-routing intent. A recipient whose group has never
been released is rejected without mutation; only the normal routing-release transition performed by
approval or signing can make it eligible, never reissue. The full eligibility rule is therefore: the
envelope must be `sent` or `in_progress`; the recipient must be `pending` or `viewed`; and the
recipient must already have been released, meaning `recipient.capability_expires_at IS NOT NULL` and
its current outbox row is not a still-blocked future-routing reservation. Once release has occurred,
whether that capability now happens to be still live, capability-expired, or revoked is irrelevant
to eligibility and affects only which capability the new one supersedes; a still-`blocked` recipient
is never eligible, because minting a new expiry for it would make its link resolvable before its
order opens.

The transaction boundary matches the existing decline/void/approve pattern rather than introducing a
new one. PostgreSQL locks the envelope row, then the target recipient row, then the recipient's
existing outbox row(s), in that stable order inside one transaction, before superseding the old
capability, inserting the new capability and a new delivery outbox row, and appending the reissue
audit event. D1 performs the same sequence behind one command insert and a
rollback-on-failed-predicate trigger, so supersession, new-capability insertion, new-outbox
insertion, and audit append either all become visible together or none do. As with decline and void,
a `processing` delivery lease observed on the recipient's current outbox row before publication
fences the entire reissue with a retryable conflict and no partial write, so a reissue can never
race an in-flight provider submission for the capability it is about to supersede. The release
predicate above — recipient status, `capability_expires_at IS NOT NULL`, and an outbox row that is
not still `blocked` — is rechecked inside this same atomic boundary alongside the lease fence and
the capability-supersession CAS, not as a separate earlier check: PostgreSQL rechecks it under the
recipient row lock immediately before superseding, and D1's rollback-on-failed-predicate trigger
guards it as one of the same predicates. Reissue evaluates that predicate atomically under its own
publication boundary: if it observes the recipient still unreleased, it fails closed with no
mutation, exactly as above. If a concurrent routing-group release instead commits first, reissue
then observes an already-released recipient and may legitimately proceed as an ordinary
already-released reissue — the two commands are never interleaved and no execution can publish a
reissued live capability before the routing release that made the recipient eligible; each recheck
simply sees whichever fully committed state existed first.

Reissue must never overwrite delivery outbox history. Each reissue creates a new outbox row for the
new capability rather than mutating or deleting the prior row; delivered and
already-permanent-failure evidence on earlier rows remains exactly as retained today. Distinct
invitation issuances remain an ordered sequence of outbox rows, never one mutable slot.

Issuance lineage, the reissue command, append-only delivery history, and view continuation are one
atomic feature boundary with D1/PostgreSQL parity tests.

## Required outcomes

- Reissuing an already-released, `pending`, not-yet-viewed recipient
  (`recipient.capability_expires_at IS NOT NULL`) mints one new live capability, supersedes the old
  one, leaves the recipient `pending`, appends one `recipient.capability_reissued` event whose
  public payload contains only the recipient ID, reason, and timestamps, and makes the old link
  resolve `not_found`.
- Reissuing a recipient who has already been released at least once
  (`recipient.capability_expires_at IS NOT NULL`) and whose current capability has simply
  capability-expired, while the recipient remains `pending` or `viewed` and the envelope remains
  `sent` or `in_progress`, is accepted; reissuing a recipient inside an envelope-terminal `expired`,
  `voided`, or `completed` state, or a `declined` or `completed` recipient, is rejected without
  mutation.
- Reissuing a `pending` recipient in a later, not-yet-released routing group —
  `recipient.capability_expires_at` still `NULL` and its outbox row still `blocked` — is rejected
  without mutation regardless of envelope state; only the normal routing-release transition
  performed by approval or signing can make that recipient eligible, never reissue.
- A routing-group release and a concurrent reissue attempt racing the same recipient never
  interleave: the D1 trigger and PostgreSQL transaction recheck the release predicate atomically
  with status, lease, and the capability-supersession CAS; reissue fails closed with no mutation if
  it observes the recipient still unreleased, and may otherwise proceed as an ordinary
  already-released reissue if the release fully committed first, but no execution ever publishes a
  reissued live capability ahead of the routing release itself.
- A live replacement capability presented for an already-`viewed` recipient with intact lineage
  results in continuation: no second `recipient.viewed` event, and the request is not recorded as an
  idempotency-key replay.
- A live capability presented for an already-`viewed` recipient whose lineage back to the capability
  that recorded the view cannot be proven results in `integrity_error`, with no `Set-Cookie` in the
  response.
- A token that is not live at all (unknown hash, revoked, or capability-expired with nothing
  superseding it) results in `not_found`, with no `Set-Cookie` in the response; the existing cookie,
  if any, is left completely untouched.
- Every non-terminal denial or error outcome — `not_found`, `context_mismatch`, `integrity_error`,
  and `unavailable` — emits no `Set-Cookie` deletion under any circumstance.
- Race ordering: an old-capability request (H1) begins, a concurrent valid replacement-link exchange
  (H2) completes and sets the live cookie, and H1's denial response arrives after H2's; H1's
  response carries no `Set-Cookie`, so H2's cookie survives untouched.
- Cross-tab: after one tab exchanges a valid replacement link and the shared cookie is updated to
  the new live token, a second, stale tab for the same recipient that has not itself exchanged any
  link observes that same live cookie on its next request and must lineage-continue rather than
  erroring.
- The reissue operator command's own response never sets or clears any recipient browser cookie.
- Published/replayed decline, approve, and sign retain current terminal cookie expiry/exchange
  behavior, and tests prove reissue rejects the same completed/declined recipient so no live
  successor can race it.
- Exact idempotency-key replay of the reissue command itself returns the original receipt without
  minting a second lineage entry or a second outbox row.
- A `processing` lease on the current outbox row fences a concurrent reissue attempt with a
  retryable conflict and no partial state.
- D1 and PostgreSQL produce an identical resulting projection — recipient status, live capability,
  full outbox row history, and audit sequence — for every scenario above.

Non-goals: bulk or multi-recipient reissue in one command; changing a recipient's identity, email,
or role (reissue only replaces the capability, never the recipient row it belongs to); retroactively
altering or deleting any existing `recipient.viewed` or delivery audit evidence; and any UI, copy,
or notification design. Recipient capability reissue is also unrelated to sealing-key rotation
(tracked separately, issue #10): rotation re-encrypts existing outbox ciphertext under a new
deployment secret without changing which capability is live or minting a new token, and can happen
with or without any reissue ever occurring; reissue mints an entirely new capability and token and
never re-encrypts or reuses old ciphertext.
