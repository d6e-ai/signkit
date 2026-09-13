---
name: signkit-api
description: Guide for calling the SignKit HTTP API (/api/v1), discovering capabilities, inspecting envelopes with read-only API-key bearer tokens, validating UUIDv7 identifiers, and handling RFC 9457 error responses.
---

# SignKit API

Guide for interacting with the SignKit HTTP API (`/api/v1`). Emphasizes capability discovery, explicit organization scoping, read-only API-key boundaries, strict identifier validation, and RFC 9457 error handling.

## Capability Discovery

Before composing requests, query system capabilities:

```http
GET /api/v1/system/capabilities
Accept: application/json
```

- **Unauthenticated:** Completely ignores any presented credentials or organization headers.
- **Dynamic Truth:** Returns runtime profile (`node`, `cloudflare`, `vercel`), supported features, and dynamic API key authorization settings (`enabledScopes`, `readEndpoints`).
- **Canonical Contracts:** Consult `docs/api.md` and `docs/architecture/` in this repository for normative contracts. Never invent unexposed endpoints, webhooks, or write scopes.

## Authentication & Authority Boundaries

SignKit strictly separates credential families and enforces non-overlapping authority boundaries:

### API Key Bearer Authentication

Agents authenticate using revocable instance-scoped API keys:

```http
Authorization: Bearer signkit_<43-base64url-characters>
SignKit-Organization-Id: <organization-id>
```

- **Strict Read-Only Surface:** API keys are accepted on these `envelopes:read` endpoints:
  - `GET /api/v1/envelopes`
  - `GET /api/v1/envelopes/{envelopeId}` — envelope detail (`envelope`, `recipients`, `readyAuditEventId`, `fields`; fields omit labels)
  - `GET /api/v1/envelopes/{envelopeId}/draft`
  - `GET /api/v1/envelopes/{envelopeId}/docx` — commit-pinned DOCX bytes; never stored in Git
  - `GET /api/v1/envelopes/{envelopeId}/deliveries`
  - `GET /api/v1/envelopes/{envelopeId}/completion-artifact`
- **Authoring mutations:** Envelope create, draft commits, `POST .../draft/docx`, ready, and fields accept `drafts:write`. Send and void accept `envelopes:send`. See `GET /api/v1/system/capabilities`. DOCX import converts a bounded upload into a Markdown draft commit; the original DOCX is discarded.
- **Bearer Exclusivity on Envelope Surfaces:** On the operator envelope surface (`/api/v1/envelopes/**`), a non-empty `Authorization` header selects bearer mode for the entire request and suppresses cookie resolution. Malformed tokens, foreign credentials (`skr1_`, `skca1_`, `ski1_`, worker secrets), or unauthorized keys fail closed with an opaque `401 Unauthorized` (`urn:signkit:problem:api-key-authentication-required`) carrying a bare `WWW-Authenticate: Bearer` challenge. A valid cookie never rescues a failing bearer.
- **Narrow Management Refusal:** Presenting a well-formed `signkit_` bearer to management surfaces (`/api/v1/api-keys/**` or `/api/v1/instance/**`) is refused outright with `403 Forbidden` (`urn:signkit:problem:api-key-not-permitted`), and any accompanying cookie session is suppressed to prevent self-escalation. Note that `/api/v1/instance/bootstrap` is exempt because its `Authorization` header expects `SIGNKIT_BOOTSTRAP_SECRET` rather than a credential-family selector (returning an opaque 404 if invalid).
- **Completion publication:** Agent mutations record `actor_type = 'agent'`. Audit hash v2 includes actor type and actor id, so envelopes authored only by API keys can complete artifact publication.

For request shapes and response wrappers, see [references/endpoints.md](references/endpoints.md). For evolving full schemas, see canonical `docs/api.md`.

## Mandatory Organization Selection

For API-key envelope reads, the `SignKit-Organization-Id` header is mandatory:

- **API-Key Requests Only:** Mandatory on API-key requests to `/api/v1/envelopes/**`. Interactive operator sessions resolve organization membership directly from the verified session context, not this header.
- **Never Inferred:** The server never infers the target organization from a single grant, default setting, or cookie.
- **Format:** 1–200 visible ASCII characters without whitespace (`^[\x21-\x7E]+$`).
- **Active Grant Required:** The API key must hold an active, live grant (`api_key_organization_grant`) for the specified organization.
- **Outcomes:**
  - Missing/malformed selector: `400 Bad Request` (`urn:signkit:problem:api-key-organization-selector-required`), decided before any database lookup.
  - No active grant for organization: `403 Forbidden` (`urn:signkit:problem:api-key-organization-grant-required`).
  - Key lacks `envelopes:read` scope: `403 Forbidden` (`urn:signkit:problem:api-key-insufficient-scope`).

## Identifier and Cursor Validation

SignKit enforces strict identifier rules:

- **SignKit-Owned Identifiers:** Envelope IDs, recipient IDs, field IDs, and audit event IDs MUST be canonical lowercase RFC 9562 UUIDv7 (`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`). Uppercase hex or non-v7 UUIDs fail fast with `400 Bad Request`.
- **Malformed UUID Problem Types Differ by Endpoint:**
  - On `/deliveries` and `/completion-artifact`: returns `urn:signkit:problem:validation-error`.
  - On `/envelopes`, `/envelopes/{envelopeId}`, and `/envelopes/{envelopeId}/draft`: returns `urn:signkit:problem:validation-failed`.
  - Do not overgeneralize problem types across routes.
- **Envelope List Cursor:** The pagination cursor for `GET /api/v1/envelopes?cursor=...` MUST also be a valid canonical lowercase UUIDv7.
- **Non-Envelope Cursors:** Pagination cursors for API key lists, instance members, and invitations are bounded opaque strings (1–200 characters) forwarded unvalidated to the durable store, which authorizes the actor before resolving and fails closed if invalid.
- **Idempotency Keys:** Unique opaque strings (1–200 visible ASCII characters; UUIDv4 recommended). The server does not parse UUID structure.

## Error Handling (RFC 9457)

All error responses use `application/problem+json`:

```json
{
  "type": "urn:signkit:problem:envelope-not-found",
  "title": "Envelope not found",
  "status": 404,
  "detail": "No envelope was found in the authorized organization.",
  "instance": "/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001"
}
```

- **503 Problem Types Differ Across API-Key Reads:**
  - `GET /api/v1/envelopes/{envelopeId}/docx`: returns `urn:signkit:problem:docx-export-unavailable`.
  - `GET /api/v1/envelopes/{envelopeId}/draft`: returns `urn:signkit:problem:draft-service-unavailable`.
  - `GET /api/v1/envelopes/{envelopeId}/deliveries`: returns `urn:signkit:problem:delivery-status-unavailable`.
  - `GET /api/v1/envelopes/{envelopeId}/completion-artifact`: returns `urn:signkit:problem:completion-artifact-status-unavailable`.
  - `GET /api/v1/envelopes` and `GET /api/v1/envelopes/{envelopeId}`: may return `urn:signkit:problem:persistence-unavailable` or `urn:signkit:problem:service-unavailable`.

### Problem Types Summary

| Status | URN Type | Scope & Cause |
| :---: | :--- | :--- |
| `400` | `urn:signkit:problem:api-key-organization-selector-required` | Missing or malformed `SignKit-Organization-Id` on API-key read |
| `400` | `urn:signkit:problem:validation-error` | Malformed UUIDv7 on `/deliveries` or `/completion-artifact` |
| `400` | `urn:signkit:problem:validation-failed` | Malformed UUIDv7 or invalid query on `/envelopes`, get, draft |
| `400` | `urn:signkit:problem:idempotency-key-required` | Missing `Idempotency-Key` on mutation requiring one |
| `401` | `urn:signkit:problem:api-key-authentication-required` | Unknown, revoked, expired API key, or suspended owner (`WWW-Authenticate: Bearer`) |
| `401` | `urn:signkit:problem:authentication-required` | Unauthenticated or invalid interactive operator/identity session |
| `403` | `urn:signkit:problem:api-key-organization-grant-required` | API key lacks active live grant for requested organization |
| `403` | `urn:signkit:problem:api-key-insufficient-scope` | API key lacks required scope (`envelopes:read`) |
| `403` | `urn:signkit:problem:api-key-not-permitted` | API key presented on mutation or management endpoint |
| `404` | `urn:signkit:problem:envelope-not-found` | Envelope does not exist in the authorized organization |
| `409` | `urn:signkit:problem:idempotency-conflict` | `Idempotency-Key` reused with different request payload |
| `503` | `urn:signkit:problem:draft-service-unavailable` | Draft workspace read failure on `/draft` |
| `503` | `urn:signkit:problem:delivery-status-unavailable` | Delivery status read failure on `/deliveries` |
| `503` | `urn:signkit:problem:completion-artifact-status-unavailable` | Artifact publication status read failure on `/completion-artifact` |
| `503` | `urn:signkit:problem:persistence-unavailable` | Durable envelope store unconfigured or resolution failed on list/get |
| `503` | `urn:signkit:problem:service-unavailable` | Unexpected envelope operation failure on list/get |

## Idempotency and Concurrency

Idempotency and concurrency semantics are endpoint-specific rather than universal across all POST requests:

- **Operator Mutations:** Commands such as envelope creation require `Idempotency-Key` (1–200 visible ASCII characters). Replaying an identical request returns the cached response with `idempotency-replayed: true`. Reusing a key with conflicting parameters returns `409 Conflict`.
- **Optimistic Concurrency:** State transitions require explicit expected markers:
  - Draft commits: `expectedGeneration`
  - Ready: `expectedGeneration`
  - Field placement: `expectedGeneration` and `expectedFieldGeneration`
  - Send: `expectedGeneration` and `expectedReadyAuditEventId`
  - Voiding: `expectedStatus` and `expectedGeneration`
- **Worker Drain Endpoints (Exceptions):** System background drains and sweeps (`POST /api/v1/system/deliveries/drain`, `POST /api/v1/system/deliveries/reseal-sweep`, `POST /api/v1/system/completion-artifacts/drain`, `POST /api/v1/system/completion-deliveries/drain`, `POST /api/v1/system/completion-deliveries/reseal-sweep`, `POST /api/v1/system/envelopes/expiry-drain`, `POST /api/v1/system/webhooks/drain`, `POST /api/v1/system/objects/orphan-sweep`) authenticate using `Authorization: Bearer DELIVERY_WORKER_SECRET` and do NOT require `Idempotency-Key` headers.
- **Canonical Details:** Consult `docs/api.md` for mutation body definitions and concurrency contracts.
