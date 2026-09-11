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

The raw random capability exists durably only as AES-256-GCM ciphertext in the delivery outbox, sealed with a deployment secret and organization/envelope/recipient/outbox context as authenticated data. Recipient rows contain the SHA-256 hash; public responses and audit payloads contain neither token, hash, ciphertext, key ID, nor outbox ID. A future delivery worker decrypts immediately before delivery, verifies the token hash, and scrubs ciphertext after provider acceptance. `envelope.sent` means that delivery intent is durable, not that an email provider has accepted a message. D1 uses a final publish guard to verify the full outbox/capability projection before the state CAS and audit append; PostgreSQL uses row locks and one transaction. Provider delivery and routing-group release remain separate workers/commands.

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

| Runtime     | Database   | Objects               | Background work                  |
| ----------- | ---------- | --------------------- | -------------------------------- |
| Node/Docker | PostgreSQL | S3-compatible         | transactional outbox worker      |
| Cloudflare  | D1 binding | native R2 binding     | D1 outbox, then Queues/Workflows |
| Vercel      | PostgreSQL | external S3 initially | platform-specific                |

D1 and PostgreSQL keep distinct migrations behind the same domain-shaped ports. The shared model avoids database enums, arrays, and mandatory JSON-specific column types. Every tenant-owned table carries `organization_id`; composite keys and foreign keys include it so rows cannot be linked across tenants accidentally.

SQL and object storage do not share a transaction. Objects are immutable; a successful SQL CAS publishes the new pointer. Failed uploads remain invisible and are safe for later orphan collection.

R2 is used through its in-process Worker binding, not the S3/REST endpoint. Node uses the S3 adapter. Native Vercel Blob is not S3-compatible and remains a separate future adapter.

## Authentication and authorization

The sender/admin UI uses d6e-auth authorization-code OAuth. Access tokens are verified with RS256, issuer `d6e-auth`, and audience equal to `D6E_AUTH_CLIENT_ID`. Tokens remain inside an AES-GCM-encrypted, `HttpOnly`, `SameSite=Lax` server cookie.

d6e-auth proves identity, not envelope or organization access. Active organization memberships are fetched server-side. Suspended and closed organizations are rejected. A remembered organization cookie is display state only. Every query and mutation must match the authorized organization and object ID.

Recipient signing uses a separate, narrow capability link: high entropy, one recipient, stored as a hash, expiring, revocable, rate-limited, and unable to call operator APIs. A recipient does not need a d6e account by default. `GET /api/v1/signing/context` resolves only a bearer capability and is independent from browser OAuth organization state. Its D1 and PostgreSQL queries require a non-null future expiry, no revocation, a `pending` or `viewed` non-CC recipient, a `sent` or `in_progress` envelope, and a composite organization/envelope join. The response is an explicit allowlist that excludes organization identity, recipient email/name, and all token material; all inactive capability cases share one not-found shape. The later `/s/<token>` UI will call this boundary without adding signing mutations or view-audit side effects to the read.

Agents and the future CLI use revocable organization-scoped workload credentials with explicit scopes such as `envelopes:read`, `drafts:write`, and `envelopes:send`. They never use browser cookies or the OAuth client secret.

## Agent-first contract

The first-party UI calls the same versioned application API available to agents. Core commands are create envelope, add documents, commit draft, add recipients, place fields, send, sign/approve/decline, read status, and export evidence.

Every mutation requires:

- an idempotency key;
- the expected state or repository generation;
- actor type and stable actor ID;
- provenance such as API client, automation run, or user session;
- an optional external ID for reconciliation.

The API will use OpenAPI 3.1, structured validation, RFC 9457 problem responses, cursor pagination, and signed retryable webhooks. Stable events include `draft.revision_created`, `envelope.ready`, `envelope.sent`, `recipient.viewed`, `recipient.signed`, `recipient.declined`, `envelope.completed`, and `envelope.voided`.

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
