# Authorization and instance administration

SignKit is single-instance software: one deployment and one database form the complete authorization boundary. d6e-auth proves a human identity; SignKit decides what that identity may do from its own `instance_member` row.

The member row also keeps nullable display-name and email snapshots from that user's verified d6e-auth principal so administrators can recognize people instead of seeing external subject identifiers. These snapshots are display-only, are refreshed from the member's own authenticated session, and never grant membership, select a member, or affect any authorization decision.

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
