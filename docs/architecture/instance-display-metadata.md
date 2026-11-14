# Instance display metadata

Authorized owner and admin list pages may show human-readable member and invitation labels.
Those labels are a display projection only. They never authorize a request, never replace
`instance_member` or invitation receipts, and never appear on mutation receipts or `/me`.

This is the canonical contract. [Authorization](authorization-and-instance-administration.md)
keeps membership and invitation authority zero-PII. Operational cleanup and key rotation live in
[deployment](../deployment.md#background-jobs).

## Storage

`instance_member` and the existing `InstanceMemberMetadata` / `InstanceInvitationMetadata`
projections stay unchanged. Display data is stored in separate encrypted tables:

- `instance_member_display` is keyed by `user_id` and cascades when that member is deleted.
- `instance_invitation_display` is keyed by `invitation_id`. Acceptance or revocation deletes the
  target row in the same database transaction as the status change. Invitation deletion also
  cascades.

Legacy members and invitations have no snapshot or target row. SignKit does not backfill display
data from mail payloads, token-bearing ciphertext, or request bodies.

## Member snapshots

A member snapshot contains only `name`, `email`, `observedAt`, and `expiresAt`. Retention is 90
days after the original provider-verified profile observation that produced that snapshot. A newer
observation replaces the snapshot and starts a new 90-day window.

Only the authenticated member's own verified session claims may write that member's snapshot, and
only while the local member is `active`. The write target is the session subject. Request bodies,
query parameters, and caller-supplied display values cannot select another member or supply the
stored name or email.

Suspended members are not refreshed from later requests. Authorized admins may still read a
suspended member's snapshot until it expires. Writes ignore an observation that is older than or
equal to the stored `observedAt`.

Logical reads treat expired, corrupt, cross-record, or unknown-key ciphertext as
`{ state: "unavailable" }`. They do not invent a name, silently show an unmarked stale profile, or
delete still-live recoverable ciphertext.

## Session observation

Sealed operator sessions may carry `profileObservedAt` and `profileStoredAt`.

`profileObservedAt` is set on a successful OAuth callback or code exchange and on a successful
token refresh. `verifyAccessToken` of the same access token, cookie reseal, and
login-before-membership dwell preserve it. Membership `createdAt`, invitation `acceptedAt`, and
ordinary request handling are not profile observations.

Legacy cookies without a trustworthy observation stay unavailable until refresh or
reauthentication.

After local active membership is resolved, SignKit best-effort captures the snapshot from that
session observation. A cookie marker (`profileStoredAt` matching `profileObservedAt`) prevents a
database write and encryption on every later request for the same observation. Successful
bootstrap and invitation acceptance capture immediately so the new member does not need another
page load; the original pre-membership observation time is the snapshot time.

Display capture failure never fails authentication, membership resolution, bootstrap, or
invitation acceptance. Logs use fixed redacted codes and never include raw errors, identifiers,
email, names, ciphertext, keys, or tokens.

Cookie principal authority, API-key bearer exclusion, and recipient-surface session exclusion are
unchanged.

## Invitation targets

Fresh invitation creation stores a separately encrypted `{ email }` display record in the same
transaction as the invitation, delivery outbox, and idempotency receipt. The existing
`{ email, token }` mail ciphertext still scrubs on delivery, terminal failure, acceptance, and
revocation. The display target has no token and remains for pending unexpired invitations after
successful delivery.

Acceptance and revocation remove the target. Expiry is hidden immediately on authorized list reads
and physically removed by bounded maintenance. Exact idempotent replay never recreates a scrubbed
target or extends retention. Public metadata, receipts, command fingerprints, actor checks, and
authorization outcomes stay zero-PII.

## List projection

Only `GET` list enrichment adds display maps, after the existing session-only owner/admin list
authorization, and only for that already-authorized page (at most 100 rows):

- member list: `memberDisplays: Record<userId, MemberDisplay>` plus the original `members` array
  and cursor
- invitation list: `invitationDisplays: Record<invitationId, InvitationDisplay>` plus the original
  `invitations` array and cursor

Storage queries re-check that the actor is an active owner or admin and use only that page's
identifiers. There is no directory endpoint, no N+1 remote profile lookup, and no
client-selected arbitrary profile read.

Member display states:

- `{ state: "available", name, email, observedAt, expiresAt }`
- `{ state: "unavailable" }`

Invitation display states:

- pending unexpired: `{ state: "pending", email }`
- accepted: `{ state: "accepted", member: MemberDisplay }` using `acceptedByUserId` from that page
- revoked or expired: `{ state: "redacted" }`
- missing, legacy, corrupt, or unconfigured: `{ state: "unavailable" }`

Decoded objects are allowlisted. Ciphertext, hashes, key IDs, and hidden payload fields are never
projected. Display maps are null-prototype objects so subject identifiers such as `__proto__` remain
own properties. If display enrichment fails, the metadata page remains usable with unavailable
display states. Production list routes always attach the maps and `Cache-Control: no-store`.

## Encryption

Display ciphertext uses the `DELIVERY_ENCRYPTION_KEY` active/previous pair with purpose-derived
keys, distinct prefixes, and AAD bound to kind plus record id. It does not use
`SESSION_ENCRYPTION_KEY` and does not reuse the token-bearing invitation mail payload format.

New writes use the active key. Member payloads include timestamp and lifetime fields that must
match on open. Unknown keys are unavailable; the keyring is not widened and recoverable
ciphertext is not deleted. Unopenable previous-key rows stay physically retained until expiry.

## Maintenance

`POST /api/v1/system/instance-display/maintain` uses `DELIVERY_WORKER_SECRET` and the scheduled
maintenance registry. It needs only the database: cleanup runs without an encryption key, without a
well-formed keyring, and without mail provider, public origin, or from-email configuration. Reseal
runs when the active/previous display keyring exists.

Each run shares one cleanup budget of at most 100 expired member and invitation rows, then reseals
at most 50 previous-key rows. Discovery is an indexed query for the known previous key plus a
`reseal_after` cursor, so unknown-key and already-deferred corrupt rows cannot starve healthy
previous-key members or invitations. Compare-and-swap updates match the original ciphertext and
expiry so accepted, revoked, expired, or replaced rows are not revived. Unopenable previous-key
rows defer until their expiry without mutating live ciphertext. Responses expose bounded counts and
fixed redacted failure counters only.
