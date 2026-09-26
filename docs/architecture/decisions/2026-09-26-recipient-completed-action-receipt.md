# Recipient completed-action receipt

Date: 2026-09-26

Status: Accepted

## Context

A signer or approver who followed their original invitation link after completing their action reached `/{locale}/sign?access=invalid` and a generic unavailable screen. Completing an action revokes the recipient's capability, so the access application no longer resolves it, and `/s/{capability}` only knew how to recover a _declined_ receipt. The same dead end appeared on a plain reload, because the live recipient-session cookie still held the now-revoked capability.

Nothing was missing from the evidence. `recipient_signed_command` and `recipient_approved_command` already record `capability_hash`, `updated_at`, the audit event id/sequence/hashes/payload, and the chained `envelope.completed` columns, in both dialects. A completed recipient's `capability_hash` is immutable too, because capability reissue requires `pending` or `viewed` — the same invariant the declined receipt already relies on.

## Decision

- Add a read-only completed-action receipt mirroring the declined receipt chain: a port, a dialect-neutral evidence prover, D1/PostgreSQL stores, an application, and a separate encrypted cookie. No forward migration, because every fact is already durable.
- Authorization comes only from durable evidence. A receipt requires a command row whose `capability_hash` matches both the presented capability and the recipient projection; `recipient.status = 'completed'`; the recipient's role matching the command's table; `capability_revoked_at` equal to the command's `updated_at`; the envelope's `sent_commit_sha` equal to both the command's and `repository_head`; a re-derived audit payload and event hash equal to the stored ones; the `audit_event` row and its `sequence - 1` predecessor intact; and, when the command carried the chained completion, an `envelope.completed` event at `sequence + 1` that chains from and re-hashes to the stored values. Recipient status alone is never sufficient, and no client-supplied field is trusted.
- No mutation authority is restored, and no document authority. The receipt carries the envelope id, recipient id, action, completion time, whole-envelope status, and locale. Source Markdown, the sent PDF, field values, evidence bundles, and completion artifacts keep their existing dedicated authorizations, unchanged.
- The signer request-hash asymmetry is deliberate. The approve command's `request_hash` is a pure function of durable columns and is re-derived. The sign command's `request_hash` covers the recipient's submitted plaintext values, which this path must never read, so it is not re-derived. Instead the signer's declared `{id, fieldType, valueSha256}` digests must exactly reproduce the immutable `field_value` rows, each joined to an `envelope_field` the same recipient owns in the same envelope with the same type. `field_value.value_json` is never selected, so no signature content can reach a receipt.
- Expiry reuses the declined receipt's 30 days, measured from the completed action, with the cookie's `maxAge` bounded identically. A recipient who reaches a terminal state for their own action keeps a read-only record for the same window, whichever terminal state it was. There is no reissue or renewal path: an expired receipt fails closed, and a capability that expired without ever being used has no command row and so also fails closed. Both return the same generic invalid response as an unknown link.
- A voided or expired envelope fails closed to the generic invalid response; only `in_progress` and `completed` envelope states surface a receipt. A signer whose sender later voids the envelope loses the receipt. That is deliberately conservative, and neither mutation nor document access is recovered in any case.
- The cookie is separate. `signkit_completed_receipt_<envelopeId>` is host-only, root-path, `HttpOnly`, `SameSite=Lax`, and 30-day-bounded. It derives its own HKDF subkey (`signkit:completed-receipt-key:v1`) and uses its own AAD prefix bound to the envelope id, so it cannot be interchanged with the declined receipt cookie or the live recipient session, and there is no cross-envelope fallback. It stores only a locator; the receipt is re-proven from durable evidence on every page load. The existing same-token-only rule for retiring a live session cookie is reused, so a concurrent `/s` exchange is never wiped.
- The recipient's own action and whole-envelope completion stay distinct. `action` and `completedAt` are proven facts about this recipient. `envelopeStatus` reports the envelope projection, and `envelopeCompletedByThisAction` is true only when this command carried the chained completion event, so a later recipient finishing the envelope never reads as "everyone signed because of you".
- The declined receipt flow, its semantics, and every generic invalid or unavailable response are unchanged. Declined evidence is consulted first; the two command tables are mutually exclusive for one recipient, and evidence in both fails closed.

## Consequences

Following an old invitation, or reloading, after signing or approving now shows a durable read-only receipt in the recipient's own locale instead of a generic dead end. The capability in that old link still grants nothing; it is only a lookup key into evidence that has to corroborate itself.

Because the receipt is re-proven per request, tampering with any projection, command, field-digest, or audit row makes the receipt disappear rather than degrade. That is the intended failure mode, and it means a receipt is never weaker evidence than the audit chain behind it.

## Alternatives considered

- **Trust `recipient.status = 'completed'` and skip the audit re-derivation:** rejected. A status projection is not evidence, and the declined receipt already set the stronger precedent.
- **Broaden the declined receipt to cover completions:** rejected. It would blur two distinct terminal states and risk widening decline's authorization surface.
- **Restore document or completion-artifact access with the receipt:** rejected. Those have their own authorizations; a revoked capability must not become a back door to pinned bytes.
- **Re-derive the signer `request_hash` by reading `field_value.value_json`:** rejected. It would pull signed plaintext into a read-only receipt path for no binding beyond what the digests and audit chain already give.
- **Surface a receipt for voided or expired envelopes:** deferred. It needs its own decision about what a receipt means once the agreement itself is dead.
