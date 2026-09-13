# Agent-first contract

Status: implemented — Rust CLI reads and authoring/send/DOCX mutations, a served OpenAPI 3.1 document, and signed retryable webhooks; OpenAPI does not yet enumerate every shipped path

The first-party UI calls the same versioned application API available to agents, except session-only management surfaces (instance administration, API-key and grant management, webhooks, and capability reissue). Core commands are create envelope, add documents, commit draft, add recipients, place fields, send, sign/approve/decline, read status, and export evidence.

Every mutation requires:

- an idempotency key;
- the expected state or repository generation;
- actor type and stable actor ID;
- provenance such as API client, automation run, or user session;
- an optional external ID for reconciliation.

The API serves an OpenAPI 3.1 document at `GET /api/v1/openapi.json`, with structured validation, RFC 9457 problem responses, cursor pagination on list endpoints, and signed retryable webhooks. Webhook management (`POST`/`GET /api/v1/webhooks`, `GET /api/v1/webhooks/{webhookId}`, `POST /api/v1/webhooks/{webhookId}/revoke`, `GET /api/v1/webhooks/{webhookId}/deliveries`) is organization-session only (owner/admin); API keys are refused with 403 `api-key-not-permitted`. Delivery is `POST /api/v1/system/webhooks/drain`. HMAC-SHA256 signatures cover `timestamp.body` as `v1=<hex>`. The OpenAPI document covers the core operator, webhook, instance, API-key, recipient, and drain surfaces; it does not yet enumerate capability reissue, operator evidence/PDF, signature-asset upload, or public `?format=pdf`. Stable events include `envelope.created`, `draft.revision_created`, `envelope.ready`, `envelope.fields_placed`, `envelope.sent`, `recipient.viewed`, `recipient.signed`, `recipient.declined`, `recipient.approved`, `recipient.capability_reissued`, `envelope.completed`, `envelope.completion_artifact_published`, `envelope.voided`, and `envelope.expired`.

## Rust CLI architecture (`signkit`)

The first production-quality CLI slice lives in `cli/` with binary name `signkit` (see [cli.md](../cli.md)). Built for automated, non-interactive agent integration, its design rules are:

- **Truthful scope exposure:** System capabilities, JSON envelope inspection (`list`, `get`, `draft`, `deliveries`, `completion-artifact`; `audit` and `evidence` are aliases of that status read, not `GET .../evidence` or `GET .../pdf`), API-key authoring/send mutations, and bounded DOCX import/export. API-key, instance, webhook, and reissue management remain unexposed in the CLI.
- **Mandatory explicit organization selection:** The organization selector is required for all envelope commands and is never inferred.
- **Credential hygiene:** API keys are ingested solely from the `SIGNKIT_API_KEY` environment variable or `--api-key-stdin`. Command-line flags and configuration files are prohibited from holding secret material.
- **Fail-closed network posture:** Redirects are completely disabled to prevent credential leakage. Responses are strictly bounded to prevent OOM risks. Timeouts are enforced.
- **Deterministic machine interface:** Every error produces an RFC 9457 problem document to stderr; every success produces versioned JSON (`{"version": "1", "data": ...}`); exact exit codes (`0`..`8`) govern all success and failure outcomes.
- **Explicit typing:** Explicit Rust structs are used at all serialization and deserialization boundaries to eliminate type inference ambiguities.
