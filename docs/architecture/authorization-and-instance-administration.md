# Authorization and instance administration

SignKit is single-instance software: one deployment and one database form the complete authorization
boundary. d6e-auth proves a human identity; SignKit decides what that identity may do from its own
`instance_member` row.

Member administration identifies other members by their stable d6e-auth subject. SignKit does not
copy profile data into its authorization store or attempt an unbounded directory lookup. The
provider's cross-user profile-resolution proposal,
[d6e.ai issue #218](https://github.com/d6e-ai/d6e.ai/issues/218), was closed as not planned; its
self-profile endpoints do not resolve other instance members. Authorized owner/admin list pages may
attach a separate encrypted display projection; that contract is
[instance display metadata](instance-display-metadata.md). Display values never authorize a request
and never appear on mutation receipts or `/me`.

## Operation through a d6e console

SignKit has no operator pages and no sign-in of its own. A deployment is registered with a d6e
console (`SIGNKIT_CONSOLE_URL` and `SIGNKIT_CONSOLE_ORIGINS`), and operators work there: the
console calls this server's operator API with a d6e-auth access token (see
[operator access tokens](#operator-access-tokens)). The server renders only recipient pages
(`/s`, `/sign`, `/c`); every other page path, including old dashboard, envelope, settings, setup,
and invitation links, answers a `302` to the console URL, and a server without an acceptable console
URL answers `503`. System capabilities report the configured `consoleUrl` (or `null`). Automation
uses [API keys](#api-keys), which an owner mints from the console.

## Human sessions

A human operator is the identity of a verified d6e-auth access token: its subject, display name,
email, and email-verification claim. SignKit does not read or persist external workspace membership,
and it keeps no operator session cookie; a cookie that still accompanies a request is never read.

Every operator request rechecks the local member:

- `owner` can administer members, invitations, API keys, and webhooks.
- `admin` can administer members, invitations, and webhooks.
- `member` can use the ordinary envelope surface.
- suspended or missing members are denied.

The hook shares that member read only within the current request, keyed by the authenticated
caller. Each new request reads membership again. Missing persistence remains unavailable; it never
establishes that the instance is empty. Mutation-time authorization guards and API-key ownership
checks remain independent of this read snapshot.

Remote JWKS resolvers are retained in a bounded, URL-specific cache of public verification keys.
Tokens, principals, membership, and authorization decisions are never cached across requests. Token
validation and key rotation remain jose's responsibility.

### Instance bootstrap

The first verified user may claim the empty instance only when their email matches
`SIGNKIT_BOOTSTRAP_OWNER_EMAIL`. Bootstrap is atomic and creates the first active owner; the console
offers it when the server reports that it is not yet bootstrapped. The only unsafe exception
requires all local-development signals described in
[bootstrap configuration](../deployment.md#claim-the-initial-owner-immediately-after-deploy); a
loopback origin alone is insufficient.

### Instance invitations

Invitations bind a verified email address to a future d6e-auth subject. Acceptance requires the
caller's verified email to match, and creates or reactivates the local member in one transaction.

Creating an invitation also creates exactly one durable outbox row in the same database transaction
as the invitation and its idempotency receipt. The invited mailbox is never stored as plaintext: it
is sealed (together with a one-time token kept for payload integrity) with
`DELIVERY_ENCRYPTION_KEY`, using purpose-specific authenticated data bound to the invitation and
outbox identifiers. Exact command replay proves the original row and never creates another. The API
returns only that delivery was scheduled.

The invitation is delivered to D6E Auth, not by email from this server. The create command sends
D6E Auth a note — the normalized invited email, the expiry, the inviter's subject, and the language
(`locale`: `ja-JP` or `en-US`) — authenticated with this server's OAuth client credentials. D6E Auth
lists the server for the invitee in the console and emails them a link to join there; this server
sends no invitation mail. The create response waits for the note, so a revoke issued from it cannot
be overtaken by a late note, and the outbox row is stored with `available_at` 60 seconds ahead while
it does. When D6E Auth stores the note (or already holds a withdrawal for the id, `409
invitation_revoked`), the row is closed as handed off: status `delivered`, provider id
`d6e-auth:console-invitation-email`, sealed payload erased. Otherwise (D6E Auth unreachable or
refusing, or no console configured) the row is released at once, and the protected
instance-invitation drain retries the same note with a five-minute reclaimable lease, capped
exponential backoff, and at most ten claimed attempts. The drain rechecks the invitation's
pending/unexpired state and the payload's digests after opening it. If the create request ends
before deciding, the hold lapses and the drain sends the note; D6E Auth treats a repeated note as the
same note and emails only the first time it sees an invitation and address.

The revoke endpoint withdraws the note; acceptance does not, because the console's own acceptance
consumes it. The withdrawal may finish after the revoke response. D6E Auth refuses a note for an
invitation it has seen withdrawn, so no ordering can revive a revoked invitation. Revocations
cascaded by member suspension or demotion do not withdraw notes; such notes lapse at their expiry,
and accepting through the console then meets the same opaque failure. Notes never follow redirects,
and a failure is logged by event name and status only. There is no separate resend of an instance
invitation; a new invitation has a new id and D6E Auth emails for it again.

#### Accepting an invitation

Creating an invitation stores, beside it, a recipient lookup: an HMAC of the normalized invited email
under a purpose-separated key derived from `DELIVERY_ENCRYPTION_KEY`. It is never the email itself,
and without that key the database alone cannot test candidate addresses; a holder of both the
database and the key can, exactly as with the keyed request fingerprints.

`GET /api/v1/instance/invitations/received` lists pending invitations, unexpired at server now, whose
lookup matches the caller's own provider-verified email claim (active or, during rotation, previous
key), newest first and at most 20. It returns only id, role, creation and expiry, plus the account
it was matched for. No request value selects the email, the list requires no membership, and active
or suspended members receive an empty list. A missing or false `email_verified` claim fails closed.

`POST /api/v1/instance/invitations/{invitationId}/accept` takes an empty body, proves the invitation
by its id and the caller's lookup, and runs the acceptance transaction. An optional
`x-signkit-expected-subject` header binds the click to the account the console displayed; if the
current verified subject differs, the server returns `account-changed` (409) before consuming the
invitation. The header never establishes identity or changes the opaque response for invalid,
expired, revoked, or wrong-email invitations. Acceptance or revocation (including revocations
cascaded by member suspension or demotion) atomically deletes the lookup; expired lookups are deleted
by the next invitation create. Both endpoints use the operator identity authorization; API keys are
rejected. System capabilities advertise them as `receivedInvitations`. Invitations created before
lookups existed can no longer be accepted, since acceptance by the emailed token link was removed;
re-invite those addresses.

The normal invitation list requests `view=active`: pending invitations whose expiry is after server
now, filtered before keyset pagination and its limit on both supported databases. Accepted users
are shown through the member list; revoked, expired and accepted invitations do not appear in the
normal invitation UI. Historical records are retained, and the list API's omitted/`all` view remains
compatible with historical readers. All views retain the same owner/admin authorization boundary.

Each active member may also own a private recipient contact book. Contact ownership comes only from
the verified session subject; no request body, query parameter, or header may select another owner
or an organization. Owner, admin, and member roles have the same access to their own contacts and no
access to another member's contacts. Unknown and cross-owner contact identifiers are deliberately
indistinguishable.

### Operator access tokens

The d6e console presents a d6e-auth access token as `Authorization: Bearer <JWT>`. SignKit verifies
it: RS256 against the
provider JWKS, issuer `d6e-auth`, audience equal to this deployment's `D6E_AUTH_CLIENT_ID`, `sub`
and `email` present, and never a refresh token. A bearer token must also carry `exp`. A token minted
for another client, including another SignKit deployment, fails the audience check.

The verified identity then takes the `instance_member` read above. Roles, suspension, the
`no_membership` bootstrap and self-profile access, and every session-only surface (dashboard,
contacts, members, invitations, API keys, webhooks, bootstrap, recipient-link reissue) apply. Envelope commands are attributed to that member as `user`, never `agent`. API
key rules are unchanged.

- The token is recognized only on the operator API surface: `/api/v1/api-keys`, `/api/v1/contacts`,
  `/api/v1/dashboard`, `/api/v1/envelopes`, `/api/v1/instance`, and `/api/v1/webhooks`. This is an
  allowlist; a new prefix stays closed until it is added. Signing, recipient, completion-artifact,
  and system endpoints and browser pages never resolve one.
- Only the exact `Bearer ` scheme followed by a compact JWS that does not start with `signkit_`
  selects this mode. Every other `Authorization` value keeps its API-key handling.
- A failed token never falls back to anything: no cookie is read.
- An invalid, expired, foreign-audience, refresh, or malformed token gets the ordinary opaque `401`
  `authentication-required` problem with `WWW-Authenticate: Bearer` and no `error` parameter. An
  unreachable key set or missing configuration is `503`.
- Every request verifies its token again; only public verification keys are cached.

## API keys

API keys belong to one `instance_member` through `owner_user_id`. They never select a tenant and
have no grant table. A key is usable only while all of these remain true:

- the key exists, is unexpired, and has not been revoked;
- its owner still exists as an active instance member;
- the requested route is on the API-key allowlist; and
- the key includes the required scope.

Effective authority is the intersection of the key scopes and its active owner's instance access.
Suspending or removing the owner disables the key on the next request. Browser cookies are ignored
whenever an API-key request is being evaluated, preventing credential composition.

Supported scopes are `envelopes:read`, `drafts:write`, and `envelopes:send`. Key creation and
revocation are human-session operations. The raw `signkit_` token is returned once; SQL stores only
its hash and non-secret prefix.

Operator settings for members, invitations, and API keys are list-first. Each route keeps its
authorization gate. Members use one heading and description and identify other members by `userId`.
Invitation and API-key creation open from a list toolbar into a Dialog; a generic creation failure
is a form-level alert and does not mark the email or key-name field invalid unless the problem is
associated with that input. Closing the API-key create Dialog does not dismiss the one-time
`signkit_` secret; only explicit dismiss does, including after a failed or tokenless follow-up
create. Scopes, expiry, and the rest of a key's metadata remain reachable on narrow viewports
through a details overlay.

## Cross-origin operator consoles

`SIGNKIT_CONSOLE_ORIGINS` lists the exact browser origins of operator consoles that may call the
operator API directly ([configuration](../deployment.md#configuration)). Entries are HTTPS origins,
or HTTP for an exact loopback host during development, without wildcard, path, query, or
credentials. Absent or blank turns the feature off; an invalid entry turns it off too and logs a
value-free diagnostic.

For a request whose `Origin` is listed:

- A preflight (`OPTIONS` with `Access-Control-Request-Method`) on the operator API surface is
  answered `204` before any credential handling or routing, with `Access-Control-Allow-Origin`
  echoing that origin, `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE`,
  `Access-Control-Allow-Headers: authorization, content-type, accept, idempotency-key,
x-signkit-expected-subject`, `Access-Control-Max-Age: 600`, and `Vary: Origin`.
- Every actual response, problem responses included, carries `Access-Control-Allow-Origin`,
  `Vary: Origin`, and
  `Access-Control-Expose-Headers: content-disposition, idempotency-replayed, location, retry-after,
www-authenticate, x-signkit-commit-sha`. `retry-after` paces a retry after a void, reissue, or DOCX
  conversion that is not ready yet; `x-signkit-commit-sha` names the draft commit a DOCX export
  rendered.
- `GET /api/v1/system/capabilities` and `GET /api/v1/openapi.json` are shared the same way, for
  `GET` only.

`Access-Control-Allow-Credentials` is never sent. A console authenticates only with an
[operator access token](#operator-access-tokens), so a browser never attaches this deployment's
cookie to a cross-origin call. CORS grants no authority: every shared request still needs its own
credential.

Any other origin, method, or path gets no CORS header; a refused preflight reaches routing and is
answered `405`. While the feature is on, eligible responses carry `Vary: Origin` whatever origin
asked. Signing, recipient, completion-artifact, and system endpoints never answer cross-origin, and
the browser recipient commands keep their explicit same-origin check. SvelteKit's CSRF check still
refuses cross-origin form content types (`application/x-www-form-urlencoded`, `multipart/form-data`,
`text/plain`); no operator endpoint accepts them, so console calls with JSON or raw
(`application/pdf`, DOCX, `application/octet-stream`) bodies are governed by this policy alone.

## Other authorities

Recipient pages use envelope-scoped capability tokens and encrypted browser sessions. They do not
become instance members and cannot reach the operator API.

### Recipient terminal receipts

A signer or approver who completes their action, and a recipient who declines, both have their
capability revoked. The original invitation link and a page reload must still show that recipient
what happened, so a revoked capability may be exchanged for a read-only terminal receipt — and for
nothing else.

A receipt is authorized only by durable evidence that corroborates itself. The presented
capability's hash must match a durable command row for that recipient and the recipient projection;
the recipient's status must be the matching terminal state; the recipient's role must match the
command's table; `capability_revoked_at` must equal the command's `updated_at`; the envelope's
`sent_commit_sha` must equal both the command's and `repository_head`; and the command's audit
payload and event hash must re-derive exactly, with the `audit_event` row and its immediate
predecessor intact. Where a completion command carried the chained `envelope.completed` event, that
event must exist at the next sequence, chain from the action's hash, and re-hash to the stored
value. A signer's declared field digests must reproduce the immutable `field_value` rows, each owned
by an `envelope_field` of the same type and recipient in the same envelope; signed plaintext values
are never read on this path. Recipient status alone never authorizes a receipt, and no
client-supplied field is trusted.

A receipt restores no authority. It grants no mutation, and no access to Markdown source, the sent
or completed PDF, field values, evidence bundles, or completion artifacts; those keep their own
authorizations. It discloses only the envelope id, recipient id, the terminal action and its time,
whole-envelope status, and the recipient's locale. A recipient's own completed action and
whole-envelope completion are reported as distinct facts, so one recipient finishing never implies
the others have.

Each receipt kind has its own envelope-scoped, host-only, `HttpOnly`, `SameSite=Lax` encrypted
cookie with its own key-derivation info and authenticated data, so the two cannot be interchanged
with each other or with a live recipient session, and there is no cross-envelope fallback. The
cookie stores only a locator; the receipt is re-proven from durable evidence on every load.

Two distinct exchanges mint that cookie, under different retirement rules. Revisiting the original
invitation link after the action re-proves the receipt from the presented capability and retires a
live session cookie only when that cookie seals the same capability. Completing a sign or approve in
the browser instead performs the exchange in the response that commits the action: the capability
the command just used recovers the durable receipt, the read-only cookie is sealed and set first,
and only then is that envelope's live session cookie retired. Without that ordering the next
tokenless reload falls through to the generic invalid response until the recipient returns to the
invitation email. Retirement is unconditional on this path because the command was authorized by
that envelope's live cookie and revoked the capability it read; no other envelope's cookie is
touched, and the live cookie is never kept as a substitute for a receipt. This is not browser-side
compare-and-delete: a concurrent response setting a newer same-envelope session can still be
superseded by the retirement response. The narrow consequence is losing that session and needing its
invitation link again, not gaining authority.

The post-commit exchange grants nothing on its own. The recovered evidence must bind to the command
that just ran — the same envelope, recipient, terminal action, idempotency key, and terminal
timestamp, on both the receipt and its locator — and the cookie's lifetime is capped at whatever
remains of the receipt's 30-day retention. Whole-envelope status is deliberately outside that
binding: another recipient may legitimately complete the envelope between the command and the
receipt read, and that race must not cost this recipient the receipt for their own action. Missing,
mismatched, or expired evidence, or a failure to seal, grants no receipt at all.

Because the action is already durable at that point, neither a failed exchange nor a failure to emit
the cookie retirement turns the sign or approve into a failed response; the command still reports
success, a fixed diagnostic that carries neither the capability nor the exception is recorded, and
at worst the recipient loses the tokenless reload. Commands that did not commit never reach the
exchange and keep their own fail-closed responses. The bearer-only recipient API is unchanged: it
carries its capability explicitly, reads, sets, and clears no cookies, and mints no receipt cookie.

Receipts are retained for 30 days from the terminal action and are not reissued or renewed. An
expired receipt, a capability that expired without ever being used, a superseded or reissued
capability, a voided or expired envelope, and any malformed, tampered, or mismatched evidence or
cookie all fail closed to the same generic invalid response as an unknown link.

Contacts are a human-session-only operator surface: a verified
[operator access token](#operator-access-tokens). API keys, recipient capabilities, any other bearer
value, and recipient-session cookies cannot authorize contact reads, search, creation, replacement,
or deletion. Presenting a disallowed bearer on the contact surface must not compose with a browser
session.

Background drains use dedicated deployment secrets. They cannot be called with a browser session or
API key.

Webhook administration requires an active instance owner or admin. Webhook delivery uses a
per-endpoint signing secret and a deployer-managed destination allowlist.

## Fail-closed rules

- Failed identity verification is unavailable, not anonymous.
- A presented bearer, an API key or an operator access token, never composes with or falls back to
  a browser cookie.
- Missing persistence is a service error, never an authorization bypass.
- Unknown or revoked keys share an opaque authentication failure.
- Authorization is evaluated on every request; it is not cached across membership changes.
- Audit actors record the human subject or API-key id that performed the action.
- Contact names, email addresses, and search terms never appear in audit payloads, logs, problem
  details, idempotency receipts, URLs, or cursors.
