# Authorization and instance administration

SignKit is single-instance software: one deployment and one database form the complete authorization boundary. d6e-auth proves a human identity; SignKit decides what that identity may do from its own `instance_member` row.

Member administration currently identifies other members by their stable d6e-auth subject. SignKit does not copy profile data into its authorization store or attempt an unbounded directory lookup; resolving those subjects for display is tracked in [d6e-auth issue #218](https://github.com/d6e-ai/d6e-auth/issues/218).

## Human sessions

After OAuth verification, SignKit retains the d6e-auth subject, display name, email, and email-verification claim. It does not read or persist external workspace membership.

Every operator request rechecks the local member:

- `owner` can administer members, invitations, API keys, and webhooks.
- `admin` can administer members, invitations, and webhooks.
- `member` can use the ordinary envelope surface.
- suspended or missing members are denied.

The first verified user may claim the empty instance only when their email matches `SIGNKIT_BOOTSTRAP_OWNER_EMAIL`. The local-development exception is opt-in and loopback-only. Bootstrap is atomic and creates the first active owner.

Invitations bind a verified email address to a future d6e-auth subject. Acceptance requires the signed-in verified email to match, and creates or reactivates the local member in one transaction.

Creating an invitation also creates exactly one durable mail-delivery row in the same database transaction as the invitation and its idempotency receipt. The invited mailbox and one-time `ski1_` token are never stored as plaintext: they are sealed together with `DELIVERY_ENCRYPTION_KEY`, using purpose-specific authenticated data bound to the invitation and delivery identifiers. Exact command replay proves the original delivery row and never creates or exposes another token. The API returns only that email delivery was scheduled.

The protected instance-invitation drain uses the deployment's configured mail provider, a five-minute reclaimable lease, capped exponential backoff, and at most ten claimed attempts. It rechecks the invitation's pending/unexpired state and both token digests after opening the payload. Delivery, terminal failure, acceptance, and revocation scrub ciphertext. Provider acceptance remains an at-least-once boundary, so a crash between provider acceptance and SQL completion can produce a rare duplicate email.

Each active member may also own a private recipient contact book. Contact ownership comes only from the verified session subject; no request body, query parameter, or header may select another owner or an organization. Owner, admin, and member roles have the same access to their own contacts and no access to another member's contacts. Unknown and cross-owner contact identifiers are deliberately indistinguishable.

## API keys

API keys belong to one `instance_member` through `owner_user_id`. They never select a tenant and have no grant table. A key is usable only while all of these remain true:

- the key exists, is unexpired, and has not been revoked;
- its owner still exists as an active instance member;
- the requested route is on the API-key allowlist; and
- the key includes the required scope.

Effective authority is the intersection of the key scopes and its active owner's instance access. Suspending or removing the owner disables the key on the next request. Browser cookies are ignored whenever an API-key request is being evaluated, preventing credential composition.

Supported scopes are `envelopes:read`, `drafts:write`, and `envelopes:send`. Key creation and revocation are human-session operations. The raw `signkit_` token is returned once; SQL stores only its hash and non-secret prefix.

## Other authorities

Recipient pages use envelope-scoped capability tokens and encrypted browser sessions. They do not become instance members and cannot reach the operator API.

### Recipient terminal receipts

A signer or approver who completes their action, and a recipient who declines, both have their capability revoked. The original invitation link and a page reload must still show that recipient what happened, so a revoked capability may be exchanged for a read-only terminal receipt — and for nothing else.

A receipt is authorized only by durable evidence that corroborates itself. The presented capability's hash must match a durable command row for that recipient and the recipient projection; the recipient's status must be the matching terminal state; the recipient's role must match the command's table; `capability_revoked_at` must equal the command's `updated_at`; the envelope's `sent_commit_sha` must equal both the command's and `repository_head`; and the command's audit payload and event hash must re-derive exactly, with the `audit_event` row and its immediate predecessor intact. Where a completion command carried the chained `envelope.completed` event, that event must exist at the next sequence, chain from the action's hash, and re-hash to the stored value. A signer's declared field digests must reproduce the immutable `field_value` rows, each owned by an `envelope_field` of the same type and recipient in the same envelope; signed plaintext values are never read on this path. Recipient status alone never authorizes a receipt, and no client-supplied field is trusted.

A receipt restores no authority. It grants no mutation, and no access to Markdown source, the sent or completed PDF, field values, evidence bundles, or completion artifacts; those keep their own authorizations. It discloses only the envelope id, recipient id, the terminal action and its time, whole-envelope status, and the recipient's locale. A recipient's own completed action and whole-envelope completion are reported as distinct facts, so one recipient finishing never implies the others have.

Each receipt kind has its own envelope-scoped, host-only, `HttpOnly`, `SameSite=Lax` encrypted cookie with its own key-derivation info and authenticated data, so the two cannot be interchanged with each other or with a live recipient session, and there is no cross-envelope fallback. The cookie stores only a locator; the receipt is re-proven from durable evidence on every load.

Two distinct exchanges mint that cookie, under different retirement rules. Revisiting the original invitation link after the action re-proves the receipt from the presented capability and retires a live session cookie only when that cookie seals the same capability, so a concurrent exchange is never destroyed. Completing a sign or approve in the browser instead performs the exchange in the response that commits the action: the capability the command just used recovers the durable receipt, the read-only cookie is sealed and set first, and only then is that envelope's live session cookie retired. Without that ordering the next tokenless reload falls through to the generic invalid response until the recipient returns to the invitation email. Retirement is unconditional on this path because the command was authorized by that envelope's live cookie, so the value dropped is the capability the command just revoked; no other envelope's cookie is touched, and the live cookie is never kept as a substitute for a receipt.

The post-commit exchange grants nothing on its own. The recovered evidence must bind to the command that just ran — the same envelope, recipient, terminal action, idempotency key, and terminal timestamp, on both the receipt and its locator — and the cookie's lifetime is capped at whatever remains of the receipt's 30-day retention. Whole-envelope status is deliberately outside that binding: another recipient may legitimately complete the envelope between the command and the receipt read, and that race must not cost this recipient the receipt for their own action. Missing, mismatched, or expired evidence, or a failure to seal, grants no receipt at all.

Because the action is already durable at that point, neither a failed exchange nor a failure to emit the cookie retirement turns the sign or approve into a failed response; the command still reports success, a fixed diagnostic that carries neither the capability nor the exception is recorded, and the recipient loses only the tokenless reload. Commands that did not commit never reach the exchange and keep their own fail-closed responses. The bearer-only recipient API is unchanged: it carries its capability explicitly, reads, sets, and clears no cookies, and mints no receipt cookie.

Receipts are retained for 30 days from the terminal action and are not reissued or renewed. An expired receipt, a capability that expired without ever being used, a superseded or reissued capability, a voided or expired envelope, and any malformed, tampered, or mismatched evidence or cookie all fail closed to the same generic invalid response as an unknown link. The completed-action receipt's derivation is recorded in [its decision note](decisions/2026-09-26-recipient-completed-action-receipt.md).

Contacts are a human-session-only operator surface. API keys, recipient capabilities, and recipient-session cookies cannot authorize contact reads, search, creation, replacement, or deletion. Presenting a disallowed bearer on the contact surface must not compose with a browser session.

Background drains use dedicated deployment secrets. They cannot be called with a browser session or API key.

Webhook administration requires an active instance owner or admin. Webhook delivery uses a per-endpoint signing secret and a deployer-managed destination allowlist.

## Fail-closed rules

- Failed identity verification is unavailable, not anonymous.
- Missing persistence is a service error, never an authorization bypass.
- Unknown or revoked keys share an opaque authentication failure.
- Authorization is evaluated on every request; it is not cached across membership changes.
- Audit actors record the human subject or API-key id that performed the action.
- Contact names, email addresses, and search terms never appear in audit payloads, logs, problem details, idempotency receipts, URLs, or cursors.

The removal of the previous multi-tenant model is recorded in [the destructive single-instance ADR](decisions/2026-09-16-single-instance-authorization.md).
