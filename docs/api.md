# HTTP API

The current `/api/v1` surface, plus the operational and security semantics that callers need. The normative contracts live in [design.md](design.md) and win on any disagreement; this document summarizes what is implemented today and links into those sections.

There is no published OpenAPI document yet, and no webhooks or rate limits.

## Authority boundaries

Three separate authorities exist, and they never substitute for one another:

- **Operator session** — d6e-auth authorization-code OAuth, RS256-verified, held in an AES-GCM `HttpOnly`, `SameSite=Lax` cookie. Every operator query and mutation must match the authorized organization and the object ID. See [design.md § Authentication and authorization](design.md#authentication-and-authorization).
- **Verified identity (no organization)** — the same d6e-auth cookie session, but for endpoints scoped to the local instance rather than a d6e organization: instance bootstrap, the current-member lookup, and API key management. `no_active_organization` is authorized here; only anonymous or unresolvable identity is rejected.
- **Recipient capability** — a high-entropy, per-recipient, expiring, revocable token stored as a hash. It cannot call operator APIs, and operator OAuth state is never part of resolving it. Recipients do not need a d6e account.
- **Completion access grant** — a purpose-separated, read-only `skca1_` token issued after completion. It conveys no signing authority and sets no cookies.

## Conventions

- **Idempotency.** Every mutation requires an `Idempotency-Key` header. Replaying the same key with the same normalized request returns the original receipt; reusing a key with a different request, or against state that has since moved, returns an RFC 9457 conflict.
- **Optimistic concurrency.** Commands carry the expected state they were composed against — envelope status, the Git `expectedGeneration`, and for field-dependent commands `expectedFieldGeneration`. A stale automation run or stale browser tab fails instead of overwriting concurrent work.
- **Identifiers.** Every SignKit-owned identifier in a path or body — envelope, recipient, field, audit event — is a canonical lowercase RFC 9562 UUIDv7 and is validated as one; anything else is a validation error rather than a not-found. Identifiers are opaque: their embedded timestamp is a coarse ordering hint, never authorization or trusted event time. List cursors are not part of this rule: the API-key list cursor is a bounded opaque token forwarded unvalidated to the durable store, which must authorize the owner before it can be resolved, so a malformed cursor fails closed there (an empty page or `owner_not_active`) rather than being rejected on shape. An `Idempotency-Key` is a unique opaque string (UUIDv4 recommended); the server never parses UUID structure and still accepts any bounded visible-ASCII key. Capability tokens and access grants are deliberately not UUIDs. See [design.md § Identifiers](design.md#identifiers).
- **Errors.** RFC 9457 problem documents.
- **Response minimization.** Responses never return object storage keys, archive bytes, capability material, audit hashes, ciphertext, or internal outbox/command IDs. Public recipient responses additionally omit organization identifiers, recipient emails and names, and raw field values.
- **Fail-closed resolution.** Missing, malformed, unknown, expired, revoked, blocked, and inactive capabilities all share one indistinguishable not-found response, so no endpoint can be used as an existence oracle.

## Operator API

Requires an authenticated d6e-auth organization session.

| Method | Path                                                 | Purpose                                |
| ------ | ---------------------------------------------------- | -------------------------------------- |
| `POST` | `/api/v1/envelopes`                                  | create an envelope                     |
| `GET`  | `/api/v1/envelopes`                                  | list envelopes in the organization     |
| `GET`  | `/api/v1/envelopes/{envelopeId}`                     | read one envelope                      |
| `GET`  | `/api/v1/envelopes/{envelopeId}/draft`               | read the draft workspace               |
| `POST` | `/api/v1/envelopes/{envelopeId}/draft/commits`       | commit Markdown draft changes          |
| `POST` | `/api/v1/envelopes/{envelopeId}/ready`               | freeze the recipient graph, mark ready |
| `POST` | `/api/v1/envelopes/{envelopeId}/fields`              | replace the signing-field placement    |
| `POST` | `/api/v1/envelopes/{envelopeId}/send`                | pin the commit and start delivery      |
| `POST` | `/api/v1/envelopes/{envelopeId}/void`                | terminal operator cancellation         |
| `GET`  | `/api/v1/envelopes/{envelopeId}/deliveries`          | invitation delivery status             |
| `GET`  | `/api/v1/envelopes/{envelopeId}/completion-artifact` | completion artifact publication status |

**Draft commits** track `documents/*.md` in the envelope's own Git repository, use expected-generation concurrency, and accept optional automation provenance. See [design.md § Draft Git repository](design.md#draft-git-repository).

**Ready** takes the expected Git generation plus a complete recipient graph. `signer` and `approver` are action-bearing; `viewer` is read-only and must share a routing order with an action-bearing recipient; `prefill` is pre-send-only and is rejected until its authoring command exists; `cc` stays outside the capability graph entirely.

**Fields** is an idempotent replace-all placement command, valid only while the envelope is `ready` and unsent. The body carries `expectedGeneration`, `expectedFieldGeneration`, and 1–50 fields, each naming a recipient, a `documents/*.md` path, a `fieldType` (`signature`, `initials`, `text`, `date`, `checkbox`), a label, a required flag, and a semantic document-order `position` — there is no page/x/y geometry in this slice. Only signer recipients in the same organization and envelope may own a field, and every path must exist in the exact workspace pinned by `expectedGeneration`. Field IDs are derived deterministically from recipient, path, type, and position, so replaying the same declarations reproduces the same IDs. Publication atomically rechecks generation, Git head, field generation, envelope state, and recipient scope, then replaces the projection, bumps the field generation, and appends one PII-minimized `envelope.fields_placed` event. The response echoes no labels.

**Send** pins the Git commit, reserves capabilities and durable delivery intents for signer, approver, and viewer recipients only, and activates the first actionable routing order together with its co-routed viewers. Later groups stay blocked.

**Void** is the operator terminal command for `draft`, `ready`, `sent`, and `in_progress` envelopes. It requires both the expected status and the expected Git generation so a stale confirmation page cannot void a concurrently changed envelope. One atomic operation fences active delivery leases, scrubs still-deliverable invitation ciphertext, revokes every issued non-completed capability without changing recipient statuses, moves the envelope to `voided`, and appends a PII-free `envelope.voided` event. Provider-accepted messages and existing permanent evidence are never rewritten.

## Instance and API keys

Requires the verified-identity authority above; none of these endpoints accept or require a d6e organization. See [design.md § Persistence](design.md#persistence) for the underlying `instance_member` / `instance_bootstrap` / `api_key` model.

| Method | Path                                 | Purpose                                         |
| ------ | ------------------------------------ | ----------------------------------------------- |
| `POST` | `/api/v1/instance/bootstrap`         | one-time claim of the initial `owner` member    |
| `GET`  | `/api/v1/instance/members/me`        | current caller's membership and bootstrap state |
| `POST` | `/api/v1/api-keys`                   | issue an owner-scoped API key                   |
| `GET`  | `/api/v1/api-keys`                   | list the owner's API keys (cursor-paginated)    |
| `POST` | `/api/v1/api-keys/{apiKeyId}/revoke` | revoke an owner-scoped API key                  |

**Bootstrap** additionally requires `Authorization: Bearer SIGNKIT_BOOTSTRAP_SECRET`, checked constant-time before identity so an invalid or unconfigured secret returns the same opaque 404 as a wrong one. The body must be the exact empty JSON object `{}`, bounded to 1 KiB. A first call on an empty instance claims the caller as the sole `owner` (201). Exact idempotency replay returns 200 with `idempotency-replayed: true`; a conflicting request fingerprint under the same key returns 409 idempotency conflict; a cross-subject or post-bootstrap attempt returns 409 already-bootstrapped. There is no un-bootstrap or ownership transfer endpoint.

**Members/me** requires identity only (no bootstrap secret) and always returns `{ member, bootstrapped }`, where `member` is `null` for a caller who is not yet a member.

**API keys** are owned by the calling `instance_member` and require that member to be currently `active`; a missing or suspended owner fails closed with `owner_not_active` before any key material is disclosed. Create accepts a name, an explicit scope list (for example `envelopes:read`, `drafts:write`, `envelopes:send`), and an optional expiry, and returns the plaintext `signkit_`-prefixed token exactly once on creation (a 200 replay carries only the stored metadata, never the token). List is cursor-paginated. Revoke is scoped to the caller's own key; an unknown or cross-owner ID returns opaque `not_found`. All three require a bounded `Idempotency-Key` and reuse the same bounded JSON body reader, `application/json` content-type check, and RFC 9457 validation shape as bootstrap.

## Recipient surface

Authority is the recipient capability — as a `Bearer` token for the two read endpoints, and as the encrypted cookie for every mutation. Submitted envelope and recipient IDs are equality constraints against a freshly resolved capability, never an alternate authority.

| Method | Path                        | Notes                                                   |
| ------ | --------------------------- | ------------------------------------------------------- |
| `GET`  | `/api/v1/signing/context`   | `Bearer` capability; minimal allowlisted context        |
| `GET`  | `/api/v1/signing/documents` | `Bearer` capability; documents at the pinned revision   |
| `POST` | `/api/v1/signing/viewed`    | records the first foreground view                       |
| `POST` | `/api/v1/signing/decline`   | terminal signer/approver decision                       |
| `POST` | `/api/v1/signing/approve`   | approver decision, releases the next order or completes |
| `POST` | `/api/v1/signing/sign`      | one-shot signer completion                              |

**Context** requires a non-revoked, future-dated capability and actionable recipient/envelope state in the database query itself. Operator OAuth sessions and organization input are deliberately not part of this route.

**Documents** returns the ordered Markdown from the exact Git revision pinned at send time. The database resolves the immutable revision locator; callers cannot supply an envelope, commit, object key, or path. The archive key is re-derived server-side, compressed bytes and gzip output are bounded, and SHA-256 plus Git HEAD are verified before anything is returned.

**Viewed** exists so that a page `GET` never becomes a mutation. It requires the encrypted cookie, an exact same-origin request, an `Idempotency-Key`, and matching IDs. The recipient transition, the optional `sent` → `in_progress` envelope transition, the command receipt, and the `recipient.viewed` event publish atomically. Stale tabs, inactive capabilities, key reuse, and audit-head races fail closed without revealing whether another recipient session is valid.

**Decline** is available only to an active signer or approver. Publication atomically marks the actor and envelope declined, revokes every other issued non-completed capability without forging their statuses, terminally fails still-deliverable invitation intents and scrubs their ciphertext, and appends one PII-free `recipient.declined` event carrying the sorted sibling-revocation manifest. Already-delivered and permanent-failure evidence is retained. A delivery lease observed before publication returns a retryable conflict with no partial write, so a terminal commit cannot race a new provider submission. On success the active capability cookie is replaced by a purpose-separated terminal-receipt cookie that expires at `declinedAt + 30 days`; it cannot read Git or object storage or call recipient mutations, and every reload re-proves the stored command, the audit event and its predecessor, and the current terminal projection before returning only IDs, statuses, timestamp, and locale.

**Approve** requires an active approver who has already viewed the documents. It marks the actor `completed`, revokes its capability, and appends `recipient.approved`. If later actions remain, it releases the next signer/approver order and its co-routed viewers; if none remain, it performs the lease-fenced terminal cleanup and appends a chained `envelope.completed` event.

**Sign** is the matching signer completion: same-origin, encrypted cookie, bounded `Idempotency-Key`, expected envelope/recipient IDs, `expectedFieldGeneration`, and exactly one typed value per owned field. Raw field values stay in SQL only — audit events and public receipts carry digests. Publication completes the actor, stores the immutable values, and either releases the next action-bearing group or performs terminal cleanup with a chained `recipient.signed` then `envelope.completed` pair. Ink capture and PDF sealing are not part of this slice.

## Browser link exchange

`GET /s/{token}` is a one-time exchange surface, not the signing page. It resolves durable state, seals the active token into a purpose-separated, `HttpOnly`, `SameSite=Lax` cookie whose lifetime cannot exceed the durable capability expiry or 30 days, and redirects to the locale-specific `/{locale}/sign` URL.

The signing page rechecks durable authorization both before and after loading the pinned revision, never exposes the raw token to client-side code, and renders only a bounded, server-sanitized Markdown node model: raw HTML stays visible as escaped text, external images become inert notices, unsafe link schemes are non-interactive, invisible Unicode controls become visible markers, and the exact escaped Markdown source stays available in a separate tab.

## Completion artifacts

Once an envelope completes, a durable reconciliation job rebuilds a canonical `signkit-completion-manifest-v1` manifest from the pinned commit plus SQL evidence, and publishes exactly one immutable artifact pointer per envelope — replaying identical evidence is safe, differing evidence is an integrity error. Manifest contents, the audit re-derivation proof, and the explicit resource bounds that surface as `completion_artifact_evidence_too_large` are specified in [design.md § Completion artifact publication](design.md#completion-artifact-publication-slice-a). This is a re-derivation guarantee: a consistent whole-database rewrite is out of scope and would require an external published anchor to detect.

Delivery then enrolls each eligible recipient exactly once and mails a read-only `skca1_` access grant. Signer, approver, viewer, and CC recipients are eligible; prefill recipients are authoring metadata and are excluded. Grants expire 30 days after enrollment; revoked or expired tokens return an opaque 404. Successful delivery scrubs the sealed token ciphertext while leaving access active, terminal failure scrubs ciphertext and permanently revokes access, and retryable failure keeps both. See [design.md § Completion artifact delivery](design.md#completion-artifact-delivery-and-public-access-slice-b).

| Method | Path                                                 | Authority             | Default format |
| ------ | ---------------------------------------------------- | --------------------- | -------------- |
| `GET`  | `/api/v1/envelopes/{envelopeId}/completion-artifact` | operator session      | JSON status    |
| `GET`  | `/api/v1/completion-artifacts`                       | `Bearer skca1_` grant | JSON           |
| `GET`  | `/c/{token}`                                         | path token            | Markdown       |

The public routes accept `?format=json|markdown` and need no cookies or d6e-auth. The operator status read is an explicit allowlist returning publication state and artifact content digests only — never storage keys, audit hashes, recipient emails or names, raw field values, capability material, or internal claim tokens.

## System endpoints

| Method | Path                                         | Authority                           |
| ------ | -------------------------------------------- | ----------------------------------- |
| `GET`  | `/api/v1/system/capabilities`                | none; static profile/runtime report |
| `POST` | `/api/v1/system/deliveries/drain`            | `Bearer DELIVERY_WORKER_SECRET`     |
| `POST` | `/api/v1/system/completion-artifacts/drain`  | `Bearer DELIVERY_WORKER_SECRET`     |
| `POST` | `/api/v1/system/completion-deliveries/drain` | `Bearer DELIVERY_WORKER_SECRET`     |

### Background drains

Each drain claims durable outbox rows with bounded leases and stable ordering, reclaims abandoned work after five minutes, backs off retryable failures, and re-reads the current lease-scoped projection immediately before decrypting or sending. Claim transactions also sweep rows that became ineligible, so a recipient or envelope state change cannot strand encrypted token material.

Invitation delivery authenticates and hashes the sealed capability before use and sends localized English or Japanese text and HTML mail. Provider acceptance atomically marks the row delivered and scrubs ciphertext. Provider configuration/authentication failures and sealing-key drift retain ciphertext for capped backoff; only recipient-scoped rejection, exhausted attempts, or integrity failures are terminal. One item-level database error does not abort its successfully processed siblings.

The provider call is outside the database transaction, so provider acceptance and database completion form an at-least-once boundary — downstream mail must tolerate rare duplicates after an ambiguous process failure. Scheduling these drains per profile is covered in [deployment.md § Background jobs](deployment.md#background-jobs).

## Not exposed yet

API keys are issued and revoked over HTTP (above), but key ownership does not itself authorize organization-scoped agent requests — that grant model, along with Bearer-authenticated agent calls against the operator/recipient APIs, is deferred. Instance membership beyond the initial bootstrap owner — invitations, role/status mutations, and any member-management UI — is out of scope. Recipient capability reissue is a documented design contract with no implementation. Webhooks, an OpenAPI document, rate limits, cursor pagination beyond the current list behaviour, ink capture, PDF sealing, DOCX conversion, audit export, and operator revoke UI remain on the backlog.
