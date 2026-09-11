# SignKit design

Status: normative draft  
Last updated: 2026-09-11

## Product boundary

SignKit is a modular monolith for drafting, sending, signing, retaining, and automating agreements. It is not a d6e-specific workflow product: d6e can orchestrate work before and after signature through the same versioned API and webhooks available to every integrator.

The open-source core must remain useful on its own. Security and evidence collection are never paywalled. Enterprise licensing applies to higher-order integrations and policy features, not to the correctness of signatures or audit capture.

OpenSign and Documenso were inspected only as product references. Both repositories use AGPL-3.0 boundaries, and Documenso has separately licensed enterprise code. SignKit must use original code, names, schema, copy, and visual expression unless the project deliberately adopts compatible license obligations later.

## Architecture

```text
SvelteKit UI · REST API · public signing links · webhooks
                            │
                 application commands/queries
                            │
       envelope · draft Git · signing · audit policies
                            │
      ┌──────────┬──────────┼──────────┬───────────┐
      │ DB port  │ object   │ identity │ jobs/mail │
      ├ Postgres ├ S3       ├ d6e-auth ├ outbox    │
      └ D1       └ R2       └ guest    └ Queue     │
```

Runtime services are created from each SvelteKit request. Cloudflare bindings come from `event.platform.env`; request-scoped state is never held in module globals. The domain and application layers do not import a platform SDK.

## Envelope model

One envelope is one send operation. It contains one or more ordered Markdown documents, one recipient graph, fields, artifacts, an audit stream, and exactly one Git repository.

Core states are:

```text
draft → ready → sent → in_progress → completed
                    ├──────────────→ declined
                    ├──────────────→ expired
                    └──────────────→ voided
```

Only `draft` is mutable. `ready` can return to `draft` before sending. Sending atomically pins `sent_commit_sha`; later changes require a new or explicitly superseding envelope. Completion occurs only after every required recipient action has committed.

Recipient roles are `signer`, `approver`, `viewer`, `prefill`, and `cc`. Recipients at the same routing order may act in parallel; higher groups wait for lower groups.

The initial recipient mutation is deliberately tied to `POST /api/v1/envelopes/{envelopeId}/ready`. The command declares the complete graph, requires at least one signer or approver, normalizes email addresses, rejects duplicates, and checks the expected Git generation. D1 publishes its command, `draft → ready` compare-and-set, recipient projection, and `envelope.ready` event in one batch; PostgreSQL uses a row lock and transaction for the same boundary. The replay receipt is stored without capability tokens, and the audit payload contains recipient IDs, roles, and routing order rather than names or email addresses.

Actual sending is a separate irreversible `POST /api/v1/envelopes/{envelopeId}/send` command. It requires the expected Git generation and ready audit event ID, atomically pins `sent_commit_sha`, reserves hashed capabilities for every non-CC recipient, and writes one durable delivery intent per reserved capability before changing `ready` to `sent`. The minimum routing-order group is `pending`; higher groups are `blocked` with no active expiry until a later recipient-completion command releases them. CC delivery belongs to completion rather than the signing-capability graph.

The raw random capability exists durably only as AES-256-GCM ciphertext in the delivery outbox, sealed with a deployment secret and organization/envelope/recipient/outbox context as authenticated data. Recipient rows contain the SHA-256 hash; public responses and audit payloads contain neither token, hash, ciphertext, key ID, nor outbox ID. The delivery worker decrypts immediately before delivery, verifies the ciphertext digest, sealing key, authenticated context, plaintext capability hash, expiry, and current recipient/envelope eligibility, and scrubs ciphertext after provider acceptance or a terminal failure. `envelope.sent` means that delivery intent is durable, not that an email provider has accepted a message. The caller-supplied ready audit event remains an immutable anchor for the same envelope, Git generation, and commit; `envelope.sent` chains from the current audit head, which may include later field-placement events. D1 uses a final publish guard to verify that anchor and the full outbox/capability projection before the state CAS and audit append; PostgreSQL uses row locks and one transaction. Provider delivery and routing-group release remain separate commands.

Invitation claims are limited to 25 rows, ordered by availability and creation, and guarded by a unique lease token. Pending and retryable failed rows become eligible at `available_at`; abandoned `processing` rows are reclaimed only after a five-minute lease. Each claimant re-reads its organization- and lease-token-scoped recipient/envelope projection immediately before decrypting or sending. The claim transaction also converts at most 100 now-ineligible due or abandoned rows per run into terminal failures and scrubs their ciphertext, using a partial cleanup index so a decline, completion, revocation, expiry, or envelope terminal transition cannot strand reusable token material indefinitely or create an unbounded periodic sweep. Completion and failure updates compare the organization, delivery ID, `processing` state, and lease token. Provider authentication, sender setup, unknown provider errors, transport failures, rate limits, and sealing-key drift remain retryable; only recipient-scoped permanent rejection, exhausted attempts, or integrity failures are terminal and scrub ciphertext. Retryable failures use capped exponential backoff for at most ten claimed attempts. A per-item store failure is isolated from sibling claims, while its lease becomes reclaimable after timeout. Cloudflare uses a one-minute scheduled trigger, D1, and the native Email Sending binding. Node/Docker exposes the same bearer-protected internal drain command for a host scheduler, backed by PostgreSQL and the Cloudflare REST adapter. Responses and logs allowlist only delivery IDs, aggregate outcomes, and stable error codes. The provider call remains non-transactional after that final state read, and the provider-acceptance/database-completion gap is explicitly at-least-once: a crash after provider acceptance can cause a later duplicate, so mail content and downstream integrations must tolerate it.

Operators read progress through organization-authorized `GET /api/v1/envelopes/{envelopeId}/deliveries`. Tenant scope comes only from the verified d6e-auth session. The response contains the envelope state plus recipient ID, role, routing order, delivery state, attempts, timestamps, and a sanitized machine error code; it omits recipient email/name, capability material, sealing metadata, provider credentials, provider response bodies, and internal outbox IDs.

`POST /api/v1/envelopes/{envelopeId}/fields` places signing fields while an envelope is `ready`, before it is sent. It is an idempotent, whole-set replace: the body carries the expected Git generation, an independent `expectedFieldGeneration` compare-and-set counter for the field set itself, and one to fifty declarations naming a recipient, a `documents/*.md` path, a field type (`signature`, `initials`, `text`, `date`, `checkbox`), a label, whether the field is required, and a semantic document-order `position`. This slice tracks reading order only; page and x/y geometry are deliberately out of scope. Only signer recipients scoped to the same organization and envelope may own a field, and every document path is validated against the exact bounded Git workspace pinned by the expected generation, reusing the same `DraftPersistenceService` read path as the draft endpoints rather than duplicating archive decoding. Field IDs are derived deterministically from the recipient, document path, field type, and position, so resubmitting the same declaration reproduces the same ID even if its label or `required` flag changed. Publishing atomically rechecks the envelope's `ready` state, Git generation and head, and field generation; replaces the entire `envelope_field` projection; increments `expectedFieldGeneration`; and appends one PII-minimized `envelope.fields_placed` audit event whose payload excludes labels. D1 uses a rollback-on-failed-predicate trigger — including a `json_each` check that every declared field's recipient is a signer in scope — gated by the same command-insert boundary as `ready`, with the field replacement itself performed as later statements in the same batch; PostgreSQL locks the envelope row and then every referenced recipient row in ID order inside one transaction before replacing the set. Fields are declared only in SQL; Git and object storage are never touched by this command. The response omits labels, audit hashes, archive/storage identifiers, emails, names, and internal command IDs.

## Draft Git repository

Tracked content is deliberately narrow:

```text
documents/<stable-document-id>.md
```

The database owns titles, ordering, recipients, field coordinates, state, and artifact references. Git never contains DOCX, PDF, signature images, access tokens, or evidence bundles.

Each edit performs these steps:

1. Read the current generation, archive key, SHA-256, and Git head.
2. Download the bounded compressed repository archive and verify its external SHA-256.
3. Restore a request-local in-memory filesystem and reject unsafe paths, excess files, and excess size.
4. Use `isomorphic-git` to edit, stage, and commit Markdown files with human/agent/system attribution.
5. Serialize sorted repository files and gzip them deterministically.
6. Upload to an immutable, content-addressed object key.
7. Publish the expected-generation pointer, durable idempotency result, and `draft.revision_created` audit event atomically in the database.
8. If publication loses a race, return a typed conflict; unreferenced content-addressed uploads are garbage-collected later and are never deleted on the request path.

Recommended key:

```text
draft-repositories/v1/organizations/{organization}/envelopes/{envelope}/sha256/{sha256}.git.gz
```

Git SHA-1 identifies revisions but is not the storage integrity boundary. Every archive and final artifact also has a SHA-256 digest. The current application service implements bounded archive reads, external SHA-256 verification, immutable object writes, and generation-based publication. `GET /api/v1/envelopes/{envelopeId}/draft` exposes normalized Markdown without leaking the internal object key or archive bytes. `POST /api/v1/envelopes/{envelopeId}/draft/commits` accepts one to fifty direct `documents/*.md` edits, requires an expected generation and idempotency key, and optionally records automation provenance. D1 uses a trigger-backed command table and PostgreSQL uses a row lock plus transaction so the pointer, replay result, and audit event become visible together. Streaming archive production, orphan collection, and broader recovery tests remain before production use.

## Persistence

The initial profiles are:

| Runtime     | Database   | Objects               | Background work                     |
| ----------- | ---------- | --------------------- | ----------------------------------- |
| Node/Docker | PostgreSQL | S3-compatible         | protected outbox drain + REST mail  |
| Cloudflare  | D1 binding | native R2 binding     | scheduled D1 outbox + email binding |
| Vercel      | PostgreSQL | external S3 initially | platform-specific                   |

D1 and PostgreSQL keep distinct migrations behind the same domain-shaped ports. The shared model avoids database enums, arrays, and mandatory JSON-specific column types. Every tenant-owned table carries `organization_id`; composite keys and foreign keys include it so rows cannot be linked across tenants accidentally.

SQL and object storage do not share a transaction. Objects are immutable; a successful SQL CAS publishes the new pointer. Failed uploads remain invisible and are safe for later orphan collection.

R2 is used through its in-process Worker binding, not the S3/REST endpoint. Node uses the S3 adapter. Native Vercel Blob is not S3-compatible and remains a separate future adapter.

## Authentication and authorization

The sender/admin UI uses d6e-auth authorization-code OAuth. Access tokens are verified with RS256, issuer `d6e-auth`, and audience equal to `D6E_AUTH_CLIENT_ID`. Tokens remain inside an AES-GCM-encrypted, `HttpOnly`, `SameSite=Lax` server cookie.

d6e-auth proves identity, not envelope or organization access. Active organization memberships are fetched server-side. Suspended and closed organizations are rejected. A remembered organization cookie is display state only. Every query and mutation must match the authorized organization and object ID.

Recipient signing uses a separate, narrow capability link: high entropy, one recipient, stored as a hash, expiring, revocable, rate-limited, and unable to call operator APIs. A recipient does not need a d6e account by default. `GET /api/v1/signing/context` resolves only a bearer capability and is independent from browser OAuth organization state. Its D1 and PostgreSQL queries require a non-null future expiry, no revocation, a `pending` or `viewed` non-CC recipient, a `sent` or `in_progress` envelope, and a composite organization/envelope join. The response is an explicit allowlist that excludes organization identity, recipient email/name, and all token material; all inactive capability cases share one not-found shape.

The human `/s/<token>` route is a no-store, no-referrer exchange rather than the persistent signing page. After resolving current durable state, it seals the raw token into an AES-256-GCM `HttpOnly`, `SameSite=Lax` cookie and redirects to `/{locale}/sign`. HKDF-SHA-256 derives a recipient-session subkey from the deployment session master key, while versioned additional authenticated data prevents cross-purpose ciphertext reuse. Cookie lifetime is bounded by both the durable capability expiry and 30 days. The clean page decrypts server-side and re-resolves the database on every request; invalid or definitively inactive cookies are deleted, while transient persistence failures preserve them for retry. A failed or attacker-controlled new link never clears a previously valid session. Operator OAuth resolution is skipped for every recipient surface.

Recipient document reads resolve the pinned revision only from the active capability query. That query joins the tenant-scoped envelope to its `sent_commit_sha` revision command and requires the current immutable pointer to match the send pin; clients never submit an envelope ID, commit, object key, or path. The server reconstructs the content-addressed key, bounds the compressed archive and decoded gzip, recomputes SHA-256, requires Git HEAD to equal the send pin, and rechecks capability authorization immediately before disclosure. The browser renders exact Markdown as escaped text without raw HTML, remote resources, or active links. The bearer `GET /api/v1/signing/documents` endpoint returns the same allowlisted context and documents without organization, recipient identity, archive, digest, token, or storage details. This read path adds no view or audit mutation. Before any later signing mutation, the submitted envelope and recipient IDs must match the freshly resolved cookie context to prevent stale multi-tab actions; that invariant is tracked in issue #14.

The browser records a recipient view only through `POST /api/v1/signing/viewed` after the page is foreground-visible; link exchange, page load, prefetch, and document `GET`s remain read-only. The encrypted recipient cookie is the sole authority. Submitted envelope and recipient IDs are equality constraints against a fresh capability resolution, never alternate authority, and the endpoint accepts only exact same-origin requests. One idempotency key is scoped to the resolved recipient; a safe replay must match both the normalized request fingerprint and its stored audit evidence.

Publishing the first view changes the recipient from `pending` to `viewed`, may change its envelope from `sent` to `in_progress`, stores a durable command receipt, and appends a PII-free `recipient.viewed` audit event as one atomic database operation. PostgreSQL locks the envelope before the recipient and rechecks the capability, pinned revision, and audit head inside a transaction. D1 inserts the command through a trigger whose guarded recipient/envelope updates and audit insert roll back together on any failed predicate. A recipient already marked viewed without matching durable command and audit evidence is an integrity failure rather than an assumed replay. Revocation, expiry, recipient switching in another tab, audit-head races, and state drift are rechecked at publish and again before the response is disclosed.

Recipient decline is a separate explicit `POST /api/v1/signing/decline` confirmation, available only to an active signer or approver. It uses the encrypted recipient cookie as sole authority and treats submitted IDs only as equality constraints. Because success immediately makes the capability inactive, the decline store resolves identity by capability hash and owns both active publication and terminal replay verification; it does not depend on the active-access resolver after commit. One atomic publication marks the actor and envelope `declined`, revokes every other issued non-completed capability without changing sibling recipient statuses, stores a durable command receipt, and appends one PII-free `recipient.declined` event. D1 uses one command insert plus a rollback-on-failure trigger; PostgreSQL locks the envelope and every recipient in stable order. Delivery outbox rows and later routing groups remain unchanged. Exact evidence-checked replays succeed after response loss, while mismatched tabs, inactive or non-actionable capabilities, key reuse, audit races, and partial terminal state fail closed. Successful and replayed browser responses clear the terminal capability cookie.

Recipient approval is a separate explicit `POST /api/v1/signing/approve` confirmation, available only to an active approver who has already viewed the documents. It uses the encrypted recipient cookie as sole authority and treats submitted envelope/recipient IDs only as equality constraints; same-origin, a required bounded idempotency key, `application/json`, and a 4 KiB body cap are all enforced before the cookie is read. One atomic publication marks the actor `completed`, revokes its capability, and appends a `recipient.approved` audit event. Signer and approver roles are the action-bearing workflow participants; viewer and prefill roles never block routing-group release or envelope completion. If signer or approver actions remain in a later routing order once the acting group clears, the same publication releases the next actionable order's reserved capabilities to a bounded expiry and reopens matching blocked delivery-outbox rows, including non-CC observers co-routed at that order, while leaving recipient statuses untouched. If no signer or approver action remains outstanding, the publication instead completes the envelope: `envelope` moves to `completed` and a second, deterministically chained `envelope.completed` audit event is appended in the same publication, its `previousHash` equal to the `recipient.approved` event's own hash — a two-event hash chain rather than a separate command. D1 uses one command insert plus a rollback-on-failure trigger that performs the actor update, the conditional group release or completion, and both audit inserts; PostgreSQL locks the envelope, every recipient, and the delivery outbox in stable order inside one transaction. The application layer retries only a bounded audit-head race with a fresh timestamp; every other terminal outcome (not found, context mismatch, role not actionable, idempotency conflict, integrity error) is returned unchanged on the first attempt. Exact evidence-checked replays succeed after response loss, including when a later action has since advanced the envelope from `in_progress` to `completed`. The browser response clears the recipient session cookie only after a published or safely replayed approval; every other outcome, including a currently inactive or not-yet-eligible capability, leaves the cookie in place so an ambiguous or racy denial can never itself destroy a session a later request might still resolve.

Recipient signing is a separate explicit `POST /api/v1/signing/sign` confirmation, available only to an active signer who has already viewed the documents. The encrypted recipient cookie remains the sole authority; submitted envelope/recipient IDs and `expectedFieldGeneration` are equality/CAS constraints against a freshly resolved capability and the current field-generation pointer, so a stale page cannot sign after labels or required flags change. Same-origin, a required bounded idempotency key, `application/json`, and a 2 MiB body cap sized for the maximum valid field set are enforced before the cookie is read. The body supplies exactly one value for every field this recipient owns, including the exact empty set when none are assigned: typed signature/initials, text, a real `YYYY-MM-DD` calendar date, or a boolean checkbox. Values are normalized (trim, type, calendar validity) before the request fingerprint is hashed, together with field generation, so equivalent submissions hash identically regardless of value order. Durable replay reconstructs that fingerprint from stored `field_value.value_json` rows and fails closed if the digest, audit chain, or one-shot field set cannot be proven. Raw values and labels are written only to SQL; `recipient.signed` carries value SHA-256 digests, and the public receipt never echoes values, labels, audit hashes, or capability material. One atomic publication completes the actor, revokes only its capability, inserts immutable field values, pins the sent commit and field generation, and either releases the next routing group or completes the envelope with a chained `envelope.completed` event whose `previousHash` is the `recipient.signed` hash. D1 inserts the command through a rollback-on-failed-predicate trigger, then inserts `field_value` rows as later statements in the same batch; PostgreSQL locks the envelope, recipients, delivery outbox, envelope fields, and existing field values in stable ID order inside one transaction. Ink, PDF, DOCX, webhooks, and rate limits are out of scope.

Agents and the future CLI use revocable organization-scoped workload credentials with explicit scopes such as `envelopes:read`, `drafts:write`, and `envelopes:send`. They never use browser cookies or the OAuth client secret.

## Agent-first contract

The first-party UI calls the same versioned application API available to agents. Core commands are create envelope, add documents, commit draft, add recipients, place fields, send, sign/approve/decline, read status, and export evidence.

Every mutation requires:

- an idempotency key;
- the expected state or repository generation;
- actor type and stable actor ID;
- provenance such as API client, automation run, or user session;
- an optional external ID for reconciliation.

The API will use OpenAPI 3.1, structured validation, RFC 9457 problem responses, cursor pagination, and signed retryable webhooks. Stable events include `draft.revision_created`, `envelope.ready`, `envelope.fields_placed`, `envelope.sent`, `recipient.viewed`, `recipient.signed`, `recipient.declined`, `recipient.approved`, `envelope.completed`, and `envelope.voided`.

## Documents and evidence

DOCX import is a bounded asynchronous conversion: hostile DOCX ZIP/XML → sanitized constrained representation → normalized Markdown commit. The original DOCX is outside Git and follows an explicit retention policy. DOCX export is generated from a specific source commit and remains a transient or retained artifact outside Git.

PDF output is also derived from a pinned Git commit. The product must distinguish a visual electronic signature plus evidence trail from cryptographic PDF certification/PAdES. It must not claim the latter until certificate, timestamping, and long-term validation are implemented and verified.

Audit events are normalized append-only rows with tenant, envelope, sequence, actor, event type, canonical payload, time, previous hash, and event hash. Hash chaining improves evidence but does not make the operator-independent claim “tamper-proof.”

## Localization

Paraglide uses `en` and `ja`, in that order: URL, cookie, then base locale. Human pages have explicit `/en` and `/ja` forms while `/` remains the English base. API, well-known, health, webhook, and agent endpoints are excluded from locale routing. Signing links carry the recipient language chosen by the sender. Language controls use language names, not country flags.

## Open-core enterprise boundary

Always open source:

- audit event capture and evidence hashes;
- authorization and tenancy checks;
- backup, restore, and ordinary audit viewing;
- interoperable API and webhook formats.

Commercial modules:

- audit export to NDJSON/CSV, SIEM streaming, signed export bundles, and retention controls;
- advanced policy, reporting, compliance packs, and support;
- offline-capable commercial entitlement validation;
- SAML/SCIM enterprise identity features implemented in d6e-auth and consumed here.

Google Workspace, Microsoft Entra ID, Okta, and other enterprise SSO/SAML handling belongs in d6e-auth. SignKit must not grow a competing identity stack.

## Deployment

`DEPLOY_TARGET` selects `node`, `cloudflare`, or `vercel` at build time. Each target produces a separate artifact; there is no universal runtime build.

Node runs as a non-root user in the supplied multi-stage Docker image. A reverse proxy must preserve the public HTTPS origin used to construct the registered `/auth/callback` URI. Cloudflare uses D1/R2 bindings, `nodejs_compat`, generated binding types, and observability. Vercel compiles in CI but is not supported for production until its issue is complete.

## Primary risks

- AGPL contamination from copying upstream implementation or distinctive assets.
- cross-tenant reads or writes caused by missing organization predicates.
- inconsistent SQL/object pointers during concurrent draft commits.
- Worker exhaustion from large Git archives, DOCX ZIP bombs, PDFs, or fonts.
- leaked recipient links or over-broad agent scopes.
- audit claims stronger than the actual threat model.
- PDF rendering and CJK font differences across runtimes.
- webhook SSRF, DNS rebinding, secret leakage, or uncontrolled retries.
- jurisdiction-dependent electronic-signature requirements.
