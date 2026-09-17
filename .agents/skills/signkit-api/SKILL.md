---
name: signkit-api
description: Call the SignKit /api/v1 HTTP API for capability discovery, envelope reads and mutations, recipient workflows, UUIDv7 validation, and RFC 9457 errors.
---

# SignKit API

Use this skill when an agent must integrate with a self-hosted SignKit instance over HTTP.

## Authentication

Operator automation uses `Authorization: Bearer signkit_...`. Do not send a tenant selector. The key belongs to a local instance member and works only while that owner is active and the key includes the route's required scope.

Never print, log, decode, or place the key in a command argument. Supply it through a secret environment variable, stdin, or the caller's secret facility.

Recipient capabilities (`skr1_...`) are separate credentials for the public signing surface. Do not use them on operator endpoints.

## Workflow

1. Read `GET /api/v1/system/capabilities` before depending on an optional feature.
2. Use UUIDv7 envelope and recipient identifiers.
3. Give every mutation an `Idempotency-Key`; treat it as an opaque token. UUIDv4 is a good generator format.
4. Include the expected generation or state required by the command.
5. Handle `application/problem+json` by its `type` and `status`, not by matching prose.
6. Retry only when the error and command semantics make retry safe; reuse the same idempotency key for the same logical command.

Read [references/endpoints.md](references/endpoints.md) when selecting endpoints or scopes.

## Safety boundaries

- Do not compose browser cookies with API-key authorization.
- Do not infer authority from UUIDs, URLs, names, or email addresses.
- Do not expect object-store keys, token hashes, or audit hashes in public responses.
- API keys cannot administer instance members, invitations, keys, or webhooks.
