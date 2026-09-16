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

## Common rules

- Operator identifiers are UUIDv7.
- Mutations require an `Idempotency-Key` opaque token; UUIDv4 is recommended.
- Concurrent authoring uses `expectedGeneration` and, where relevant, `expectedFieldGeneration` or an expected state.
- Errors use `application/problem+json` following RFC 9457.
- Private object keys, token hashes, audit hashes, and raw capabilities are never returned from public models.

## Envelope endpoints

| Method | Path                                                 | Purpose                               | API-key scope    |
| ------ | ---------------------------------------------------- | ------------------------------------- | ---------------- |
| `GET`  | `/api/v1/envelopes`                                  | List envelopes                        | `envelopes:read` |
| `POST` | `/api/v1/envelopes`                                  | Create a draft envelope               | `drafts:write`   |
| `GET`  | `/api/v1/envelopes/{envelopeId}`                     | Read envelope detail                  | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/draft`               | Read the current draft                | `envelopes:read` |
| `POST` | `/api/v1/envelopes/{envelopeId}/draft/commits`       | Commit Markdown edits                 | `drafts:write`   |
| `POST` | `/api/v1/envelopes/{envelopeId}/draft/docx`          | Import DOCX as Markdown               | `drafts:write`   |
| `GET`  | `/api/v1/envelopes/{envelopeId}/docx`                | Export Markdown as DOCX               | `envelopes:read` |
| `POST` | `/api/v1/envelopes/{envelopeId}/documents/pdf`       | Add an uploaded PDF                   | `drafts:write`   |
| `POST` | `/api/v1/envelopes/{envelopeId}/documents/order`     | Reorder or remove documents           | `drafts:write`   |
| `POST` | `/api/v1/envelopes/{envelopeId}/ready`               | Validate recipients and pin readiness | `drafts:write`   |
| `POST` | `/api/v1/envelopes/{envelopeId}/fields`              | Place recipient fields                | `drafts:write`   |
| `POST` | `/api/v1/envelopes/{envelopeId}/send`                | Send a ready envelope                 | `envelopes:send` |
| `POST` | `/api/v1/envelopes/{envelopeId}/void`                | Void an active envelope               | `envelopes:send` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/deliveries`          | Read invitation status                | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/completion-artifact` | Read completion publication status    | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/evidence`            | Download JSON or Markdown evidence    | `envelopes:read` |
| `GET`  | `/api/v1/envelopes/{envelopeId}/pdf`                 | Download the executed PDF             | `envelopes:read` |

One envelope owns one ordered document set and one Git history. Markdown is committed directly. Uploaded PDFs remain immutable object bytes while Git records their manifest entries and digests. Sending pins the exact revision and renders the recipient document set.

DOCX import and export keep their synchronous success responses for browser and CLI compatibility, but conversion begins only after a durable SQL job exists. A transient inline failure remains retryable by the protected DOCX drain; repeating the same import `Idempotency-Key` or exporting the same pinned revision resolves the durable result instead of starting unrelated work. DOCX source and result bytes stay outside Git.

## Recipient endpoints

The `/api/v1/signing/**` family exchanges a capability for an envelope-scoped browser session, returns the pinned recipient workspace, records viewing, and accepts decline, approve, or sign decisions. Field submissions are validated against the pinned generation and the fields assigned to that recipient.

The public `/s/{capability}` link redirects to `/{locale}/sign/{envelopeId}` after sealing the browser session. The envelope id remains in the URL so refreshes are deterministic; authority still comes from the encrypted session, not the URL.

## Completion artifacts

After every actionable recipient completes, background reconciliation builds immutable JSON, Markdown, and PDF artifacts from the pinned document revision and SQL evidence. `GET /api/v1/completion-artifacts` and `/c/{token}` serve recipient completion grants. Completion PDFs are visual evidence, not PAdES-certified signatures.

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
