# HTTP API

SignKit exposes a versioned JSON API under `/api/v1`. Discover the live feature set at `GET /api/v1/system/capabilities` and the OpenAPI 3.1 document at `GET /api/v1/openapi.json`.

## Authentication

Operator browser requests use the d6e-auth session cookie plus an active local `instance_member` row.

Automation uses a bearer key:

```http
Authorization: Bearer signkit_<43 base64url characters>
```

No tenant selector is accepted. A key belongs to the local member that created it and works only while that owner remains active. Its scopes are intersected with the route's required scope on every request.

Recipient endpoints use `skr1_` capability links and the encrypted browser session created from them. Background drains use their dedicated deployment secrets.

The contact API is human-session-only. API keys, recipient capabilities, and recipient browser sessions do not authorize contact reads or mutations.

## Common rules

- Operator identifiers are UUIDv7.
- Mutations require an `Idempotency-Key` opaque token; UUIDv4 is recommended.
- Concurrent authoring uses `expectedGeneration` and, where relevant, `expectedFieldGeneration` or an expected state.
- Errors use `application/problem+json` following RFC 9457.
- Private object keys, token hashes, audit hashes, and raw capabilities are never returned from public models.

## OpenAPI 3.1 Specification

The live OpenAPI 3.1 specification is discoverable at `GET /api/v1/openapi.json` without authentication. It provides concrete, named schema components for all envelope queries and mutations:

- **Draft Models**: `DraftWorkspaceSnapshot`, `DocumentSetManifest`, `DocumentSetLeaf`, `MarkdownDocumentLeaf`, `PdfDocumentLeaf`
- **Envelope Models**: `EnvelopeRecipient`, `EnvelopeField`, `FieldGeometry`
- **Mutation Requests**: `DraftCommitRequest`, `ReadyEnvelopeRequest`, `PlaceFieldsRequest`, `SendEnvelopeRequest`, `VoidEnvelopeRequest`
- **Mutation Receipts**: `DraftRevisionReceipt`, `ReadyEnvelopeReceipt`, `PlaceFieldsReceipt`, `SendEnvelopeReceipt`, `VoidEnvelopeReceipt`

The `signkit openapi` CLI command retrieves this document for schema discovery.

## Envelope endpoints

| Method | Path                                                  | Purpose                               | API-key scope    |
| ------ | ----------------------------------------------------- | ------------------------------------- | ---------------- |
| `GET`  | `/api/v1/envelopes`                                   | List envelopes                        | `envelopes:read` |
| `POST` | `/api/v1/envelopes`                                   | Create a draft envelope               | `drafts:write`   |
| `GET`  | `/api/v1/envelopes/{envelopeId}`                      | Read envelope detail                  | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/draft`                | Read the current draft                | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/revisions`            | List bounded revision history         | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/revisions/{revision}` | Read exact revision snapshot or path  | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/revisions/diff`       | Structured document-set revision diff | `envelopes:read` |
| `POST` | `/api/v1/envelopes/{envelopeId}/draft/commits`        | Commit Markdown edits                 | `drafts:write`   |
| `POST` | `/api/v1/envelopes/{envelopeId}/draft/docx`           | Import DOCX as Markdown               | `drafts:write`   |
| `GET`  | `/api/v1/envelopes/{envelopeId}/docx`                 | Export Markdown as DOCX               | `envelopes:read` |
| `POST` | `/api/v1/envelopes/{envelopeId}/documents/pdf`        | Add an uploaded PDF                   | `drafts:write`   |
| `POST` | `/api/v1/envelopes/{envelopeId}/documents/order`      | Reorder or remove documents           | `drafts:write`   |
| `POST` | `/api/v1/envelopes/{envelopeId}/ready`                | Validate recipients and pin readiness | `drafts:write`   |
| `POST` | `/api/v1/envelopes/{envelopeId}/fields`               | Place recipient fields                | `drafts:write`   |
| `POST` | `/api/v1/envelopes/{envelopeId}/send`                 | Send a ready envelope                 | `envelopes:send` |
| `POST` | `/api/v1/envelopes/{envelopeId}/void`                 | Void an active envelope               | `envelopes:send` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/deliveries`           | Read invitation status                | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/completion-artifact`  | Read completion publication status    | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/pdf-seal`             | Read instance PDF seal status         | `envelopes:read` |
| `POST` | `/api/v1/envelopes/{envelopeId}/pdf-seal`             | Explicitly request an instance seal   | `envelopes:send` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/pdf-seal/pdf`         | Download the validated sealed PDF     | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/evidence`             | Download JSON or Markdown evidence    | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/pdf`                  | Download the executed PDF             | `envelopes:read` |

One envelope owns one ordered document set and one Git history. Markdown is committed directly. Uploaded PDFs remain immutable object bytes while Git records their manifest entries and digests. Sending pins the exact revision and renders the recipient document set.

DOCX import and export keep their synchronous success responses for browser and CLI compatibility, but conversion begins only after a durable SQL job exists. A transient inline failure remains retryable by the protected DOCX drain; repeating the same import `Idempotency-Key` or exporting the same pinned revision resolves the durable result instead of starting unrelated work. DOCX source and result bytes stay outside Git.

Draft revision history and diff endpoints expose content-addressed, verified Git snapshots:

- `GET /api/v1/envelopes/{envelopeId}/revisions` returns bounded historical generations (`limit` 1-100, `cursor` generation), commit SHA, ISO-8601 timestamp, commit message directly from the verified Git object, actor type, and allowlisted automation provenance (`automationRunId`, `externalId`). Internal object keys, recipient emails, capability secrets, and audit hashes are never disclosed.
- `GET /api/v1/envelopes/{envelopeId}/revisions/{revisionRef}` reads an exact revision by generation number or 40-character hexadecimal Git commit SHA. An optional `path` query parameter reads a specific document leaf; when requested with `Accept: text/markdown` or `Accept: text/plain`, the endpoint serves raw markdown text.
- `GET /api/v1/envelopes/{envelopeId}/revisions/diff` computes a bounded, structured document-set diff across Markdown and PDF manifest leaves between `base` and `head` revisions (defaulting to previous and current). Detected changes include additions, removals, content modifications, title renames, and ordering updates. It enforces machine-readable bounds (`MAX_DIFF_BYTES = 512KB`, `MAX_DIFF_FILES = 50`) and supports unified diff output via `format=text` or `Accept: text/plain`.

## Contact endpoints

Contacts are private to the verified d6e-auth subject that owns them and require that subject to remain an active local `instance_member`. A request never supplies an owner or organization selector. API keys and recipient capabilities are rejected.

For a concise Japanese description of this surface, see [Contact API (日本語)](api/contacts.ja.md).

| Method   | Path                           | Purpose                               | Idempotency-Key |
| -------- | ------------------------------ | ------------------------------------- | --------------- |
| `GET`    | `/api/v1/contacts`             | List the caller's contacts            | no              |
| `POST`   | `/api/v1/contacts/search`      | Search the caller's contacts          | no              |
| `POST`   | `/api/v1/contacts`             | Explicitly save a contact             | required        |
| `PUT`    | `/api/v1/contacts/{contactId}` | Replace a contact at an exact version | required        |
| `DELETE` | `/api/v1/contacts/{contactId}` | Delete a contact at an exact version  | required        |

List accepts only `cursor` and `limit`. Search accepts a bounded strict JSON body `{ query, cursor?, limit? }`; the query is deliberately absent from URLs, access logs, and cursors. List and search return `{ items, nextCursor }`, and a cursor contains only an owner-scoped contact UUID.

The public contact model is `{ id, email, name, locale, version, createdAt, updatedAt }`. `name` is the display name and `locale` is the preferred recipient language (`en` or `ja`). Create and replacement accept only `email`, `name`, and `locale`; replacement and deletion also require `expectedVersion`. Unknown and cross-owner IDs return the same opaque not-found response. Successful safe replays return `Idempotency-Replayed: true`; deletion returns `{ deleted: { id, deletedAt } }`.

Contacts are created only by the explicit save operation. Selecting one copies email, name, and locale into a recipient draft while leaving role and routing order unchanged. Preparing or sending an envelope never saves a contact, and changing or deleting a contact never rewrites an existing envelope recipient or its evidence.

## Recipient endpoints

The `/api/v1/signing/**` family exchanges a capability for an envelope-scoped browser session, returns the pinned recipient workspace, records viewing, and accepts decline, approve, or sign decisions. Field submissions are validated against the pinned generation and the fields assigned to that recipient.

The public `/s/{capability}` link redirects to `/{locale}/sign/{envelopeId}` after sealing the browser session. The envelope id remains in the URL so refreshes are deterministic; authority still comes from the encrypted session, not the URL.

## Completion artifacts

After every actionable recipient completes, background reconciliation builds immutable JSON, Markdown, and PDF artifacts from the pinned document revision and SQL evidence. `GET /api/v1/completion-artifacts` and `/c/{token}` serve recipient completion grants. Completion PDFs are visual evidence, not PAdES-certified signatures.

An enabled instance may explicitly request a PAdES B-B or B-T instance seal for the exact published
completion PDF. `POST /api/v1/envelopes/{envelopeId}/pdf-seal` requires `Idempotency-Key` and a
strict `{ "requestedProfile": "pades-b-b" | "pades-b-t" }` body matching the instance policy.
The scheduler never discovers or seals historical completion PDFs automatically. `GET` on the same
resource returns disabled, not-requested, pending, processing, failed, or published state and safe
verification digests, never storage keys, remote receipts, lease tokens, or audit hashes.
After the state is `published`, `GET /api/v1/envelopes/{envelopeId}/pdf-seal/pdf` returns the exact
validated sealed bytes as a private, non-cacheable PDF download. The server rechecks the immutable
publication tuple, object metadata, byte length, and SHA-256 digest on every read; a missing
publication is `404` and an integrity or storage failure is `503`.

## Instance administration

These endpoints require a human session and reject API-key credentials:

| Method | Path                                  | Purpose                       |
| ------ | ------------------------------------- | ----------------------------- |
| `POST` | `/api/v1/instance/bootstrap`          | Claim the empty instance      |
| `GET`  | `/api/v1/instance/members/me`         | Read current local membership |
| `GET`  | `/api/v1/instance/members`            | List members                  |
| `POST` | `/api/v1/instance/invitations`        | Invite a member               |
| `POST` | `/api/v1/instance/invitations/accept` | Accept an invitation          |
| `POST` | `/api/v1/api-keys`                    | Create an owner-bound API key |
| `GET`  | `/api/v1/api-keys`                    | List the caller's keys        |
| `POST` | `/api/v1/api-keys/{apiKeyId}/revoke`  | Revoke a key                  |
| `POST` | `/api/v1/webhooks`                    | Create a webhook              |
| `GET`  | `/api/v1/webhooks`                    | List webhooks                 |
| `POST` | `/api/v1/webhooks/{webhookId}/revoke` | Revoke a webhook              |

See [authorization and instance administration](architecture/authorization-and-instance-administration.md) for role and fail-closed details.

The contact endpoints above are also human-session-only, but they are ordinary per-member product data rather than instance administration.
