# SignKit API Endpoints Reference

This document provides reference details for calling the five read-only API-key endpoints under `/api/v1/envelopes/**`, along with authority rules and response wrappers.

> [!NOTE]
> For the complete and evolving normative endpoint matrix, recipient signing flows, instance administration, and mutation request contracts, consult [docs/api.md](../../../../docs/api.md).

## Representative Endpoint Matrix

The table below summarizes key endpoints and required authorities. Interactive operator sessions are established through the application via the `d6e-auth` OAuth provider (rather than presenting a provider credential, cookie, or header directly). This matrix is not exhaustive; see `docs/api.md` for the full surface.

| Method | Path | Purpose | Required Authority | API Key Allowed |
| :--- | :--- | :--- | :--- | :---: |
| `GET` | `/api/v1/system/capabilities` | Runtime profile & feature flags | None (unauthenticated) | Ignored |
| `GET` | `/api/v1/envelopes` | List envelopes in organization | `Bearer signkit_...` + `SignKit-Organization-Id` | **Yes (`envelopes:read`)** |
| `GET` | `/api/v1/envelopes/{envelopeId}` | Read single envelope metadata | `Bearer signkit_...` + `SignKit-Organization-Id` | **Yes (`envelopes:read`)** |
| `GET` | `/api/v1/envelopes/{envelopeId}/draft` | Read draft workspace snapshot | `Bearer signkit_...` + `SignKit-Organization-Id` | **Yes (`envelopes:read`)** |
| `GET` | `/api/v1/envelopes/{envelopeId}/deliveries` | Read invitation delivery status | `Bearer signkit_...` + `SignKit-Organization-Id` | **Yes (`envelopes:read`)** |
| `GET` | `/api/v1/envelopes/{envelopeId}/completion-artifact` | Read artifact publication status | `Bearer signkit_...` + `SignKit-Organization-Id` | **Yes (`envelopes:read`)** |
| `POST` | `/api/v1/envelopes` | Create new envelope | Verified interactive operator session established through the application | No (403 refused) |
| `POST` | `/api/v1/envelopes/{envelopeId}/draft/commits` | Commit Markdown changes | Verified interactive operator session established through the application | No (403 refused) |
| `POST` | `/api/v1/envelopes/{envelopeId}/ready` | Freeze recipient graph | Verified interactive operator session established through the application | No (403 refused) |
| `POST` | `/api/v1/envelopes/{envelopeId}/fields` | Place signing fields | Verified interactive operator session established through the application | No (403 refused) |
| `POST` | `/api/v1/envelopes/{envelopeId}/send` | Send envelope & start delivery | Verified interactive operator session established through the application | No (403 refused) |
| `POST` | `/api/v1/envelopes/{envelopeId}/void` | Void envelope terminally | Verified interactive operator session established through the application | No (403 refused) |
| `POST` | `/api/v1/api-keys` | Mint owner-scoped API key | Verified identity session | No (403 refused) |
| `GET` | `/api/v1/api-keys` | List owner's API keys | Verified identity session | No (403 refused) |
| `POST` | `/api/v1/api-keys/{id}/revoke` | Revoke owner's API key | Verified identity session | No (403 refused) |
| `POST` | `/api/v1/api-keys/{id}/organization-grants` | Grant key to organization | Key owner + d6e org `owner`/`admin` | No (403 refused) |
| `POST` | `/api/v1/api-keys/{id}/organization-grants/{grantId}/revoke` | Revoke organization grant | Key owner OR d6e org `owner`/`admin` | No (403 refused) |
| `POST` | `/api/v1/system/deliveries/drain` | Process invitation delivery outbox | `Bearer DELIVERY_WORKER_SECRET` | No |
| `POST` | `/api/v1/system/deliveries/reseal-sweep` | Reseal delivery capability ciphertext | `Bearer DELIVERY_WORKER_SECRET` | No |
| `POST` | `/api/v1/system/completion-artifacts/drain` | Process artifact reconciliation | `Bearer DELIVERY_WORKER_SECRET` | No |
| `POST` | `/api/v1/system/completion-deliveries/drain` | Process completion delivery outbox | `Bearer DELIVERY_WORKER_SECRET` | No |
| `POST` | `/api/v1/system/completion-deliveries/reseal-sweep` | Reseal completion token ciphertext | `Bearer DELIVERY_WORKER_SECRET` | No |
| `POST` | `/api/v1/system/envelopes/expiry-drain` | Expire lapsed sent envelopes | `Bearer DELIVERY_WORKER_SECRET` | No |
| `POST` | `/api/v1/system/webhooks/drain` | Process webhook outbox | `Bearer DELIVERY_WORKER_SECRET` | No |
| `POST` | `/api/v1/system/objects/orphan-sweep` | Collect unreferenced object uploads past the 24h grace period | `Bearer DELIVERY_WORKER_SECRET` | No |

---

## Enabled Read Operations (API Key Requests)

All five read endpoints require:
1. `Authorization: Bearer <signkit_key>`
2. `SignKit-Organization-Id: <organization_id>`

### 1. List Envelopes

Lists envelopes in the target organization using keyset pagination.

```http
GET /api/v1/envelopes?limit=25&cursor=0191b26f-4000-7000-8000-000000000001 HTTP/1.1
Host: signkit.example.com
Authorization: Bearer <CALLER_PROVIDED_KEY>
SignKit-Organization-Id: org_12345
Accept: application/json
```

**Parameters:**
- `limit`: Integer from 1 to 100 (default: 50).
- `cursor`: Keyset pagination cursor from previous page's `nextCursor` (canonical lowercase RFC 9562 UUIDv7).

**Response Wrapper (`200 OK`):**
```json
{
  "items": [
    {
      "id": "0191b26f-4000-7000-8000-000000000001",
      "organizationId": "org_12345",
      "title": "Master Services Agreement",
      "status": "in_progress",
      "repositoryGeneration": 1,
      "repositoryHead": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "repositoryArchiveKey": "org_12345/0191b26f-4000-7000-8000-000000000001/...",
      "repositoryArchiveSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "sentCommitSha": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "fieldGeneration": 1,
      "createdAt": "2026-09-11T12:00:00.000Z",
      "updatedAt": "2026-09-11T12:05:00.000Z"
    }
  ],
  "nextCursor": "0191b26f-4000-7000-8000-000000000002"
}
```

### 2. Read One Envelope

Reads metadata for a specific envelope.

```http
GET /api/v1/envelopes/0191b26f-4000-7000-8000-000000000001 HTTP/1.1
Host: signkit.example.com
Authorization: Bearer <CALLER_PROVIDED_KEY>
SignKit-Organization-Id: org_12345
Accept: application/json
```

**Response Wrapper (`200 OK`):**
```json
{
  "envelope": {
    "id": "0191b26f-4000-7000-8000-000000000001",
    "organizationId": "org_12345",
    "title": "Master Services Agreement",
    "status": "ready",
    "repositoryGeneration": 1,
    "repositoryHead": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "repositoryArchiveKey": "org_12345/0191b26f-4000-7000-8000-000000000001/...",
    "repositoryArchiveSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "sentCommitSha": null,
    "fieldGeneration": 0,
    "createdAt": "2026-09-11T12:00:00.000Z",
    "updatedAt": "2026-09-11T12:05:00.000Z"
  }
}
```

### 3. Read Draft Workspace

Reads the Git generation, commit, archive digest, and tracked Markdown documents (`documents/*.md`).

```http
GET /api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/draft HTTP/1.1
Host: signkit.example.com
Authorization: Bearer <CALLER_PROVIDED_KEY>
SignKit-Organization-Id: org_12345
Accept: application/json
```

**Response Wrapper (`200 OK`):**
```json
{
  "generation": 3,
  "commitSha": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "archiveSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "documents": [
    {
      "path": "documents/agreement.md",
      "content": "# Master Services Agreement\n\nThis agreement is made..."
    }
  ]
}
```

### 4. Read Invitation Deliveries

Reads the outbox delivery status for all recipient invitations. The response is wrapped in a top-level `delivery` object.

```http
GET /api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/deliveries HTTP/1.1
Host: signkit.example.com
Authorization: Bearer <CALLER_PROVIDED_KEY>
SignKit-Organization-Id: org_12345
Accept: application/json
```

**Response Wrapper (`200 OK`):**
```json
{
  "delivery": {
    "envelopeId": "0191b26f-4000-7000-8000-000000000001",
    "envelopeStatus": "in_progress",
    "deliveries": [
      {
        "recipientId": "0191b26f-4000-7000-8000-000000000010",
        "recipientRole": "signer",
        "routingOrder": 1,
        "status": "delivered",
        "attempts": 1,
        "availableAt": null,
        "deliveredAt": "2026-09-11T12:10:00.000Z",
        "updatedAt": "2026-09-11T12:10:00.000Z",
        "errorCode": null
      }
    ]
  }
}
```

### 5. Read Completion Artifact Status

Reads publication progress. The response is wrapped in a top-level `completionArtifact` object.

```http
GET /api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/completion-artifact HTTP/1.1
Host: signkit.example.com
Authorization: Bearer <CALLER_PROVIDED_KEY>
SignKit-Organization-Id: org_12345
Accept: application/json
```

**Response Wrapper (`200 OK`):**

When published:
```json
{
  "completionArtifact": {
    "envelopeId": "0191b26f-4000-7000-8000-000000000001",
    "status": "published",
    "publishedAt": "2026-09-11T13:00:00.000Z",
    "manifestSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "jsonSha256": "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    "markdownSha256": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
  }
}
```

When not completed, pending, processing, or failed:
- `not_completed`: `{ "completionArtifact": { "envelopeId": "...", "status": "not_completed" } }`
- `pending` / `processing`: `{ "completionArtifact": { "envelopeId": "...", "status": "pending", "attempts": 0 } }`
- `failed`: `{ "completionArtifact": { "envelopeId": "...", "status": "failed", "attempts": 3, "errorCode": "...", "availableAt": "..." } }`

---

## Problem Document Reference

RFC 9457 error URNs under `urn:signkit:problem:`:

- `urn:signkit:problem:api-key-organization-selector-required` (400): Missing or invalid `SignKit-Organization-Id` header on an API-key request.
- `urn:signkit:problem:validation-error` (400): Emitted by `/deliveries` and `/completion-artifact` when `<envelopeId>` is not a valid UUID.
- `urn:signkit:problem:validation-failed` (400): Emitted by `/envelopes`, `/envelopes/{envelopeId}`, and `/envelopes/{envelopeId}/draft` on invalid UUIDs or query parameters.
- `urn:signkit:problem:invalid-json` (400): Request body could not be parsed as UTF-8 JSON.
- `urn:signkit:problem:idempotency-key-required` (400): Mutation called without required `Idempotency-Key` header.
- `urn:signkit:problem:api-key-authentication-required` (401): API key invalid, revoked, expired, or owner suspended. Carries bare `WWW-Authenticate: Bearer` challenge. (Distinct from session `urn:signkit:problem:authentication-required`).
- `urn:signkit:problem:api-key-organization-grant-required` (403): API key exists but holds no live grant for the specified organization.
- `urn:signkit:problem:api-key-insufficient-scope` (403): API key lacks the required scope (`envelopes:read`).
- `urn:signkit:problem:api-key-not-permitted` (403): API key was presented to a mutation or management endpoint.
- `urn:signkit:problem:envelope-not-found` (404): Envelope not found in the authorized organization.
- `urn:signkit:problem:idempotency-conflict` (409): `Idempotency-Key` previously used with a different request fingerprint.
- `urn:signkit:problem:request-body-too-large` (413): Request body exceeded byte ceiling.
- `urn:signkit:problem:draft-service-unavailable` (503): Emitted by `GET /api/v1/envelopes/{envelopeId}/draft` when the draft workspace cannot be read safely.
- `urn:signkit:problem:delivery-status-unavailable` (503): Emitted by `GET /api/v1/envelopes/{envelopeId}/deliveries` when delivery status cannot be read.
- `urn:signkit:problem:completion-artifact-status-unavailable` (503): Emitted by `GET /api/v1/envelopes/{envelopeId}/completion-artifact` when publication status cannot be read.
- `urn:signkit:problem:persistence-unavailable` (503): Emitted by envelope list and get when the durable envelope store is unconfigured or resolution fails.
- `urn:signkit:problem:service-unavailable` (503): Unexpected internal processing failure (envelope list/get).
