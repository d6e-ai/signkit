# Agent-first contract

Status: implemented — Rust CLI reads, evidence/PDF and validated instance-seal download, authoring/send/DOCX mutations, explicit recipient-capability review and decisions, and PAdES B-B/B-T instance-seal requests; a served OpenAPI 3.1 document covers the live `/api/v1` surface, with signed retryable webhooks

The first-party UI calls the same versioned application API available to agents, except session-only management surfaces (instance administration, API-key management, webhooks, and capability reissue). Core commands are create envelope, add documents, commit draft, add recipients, place fields, send, sign/approve/decline, read status, and export evidence.

Every mutation requires:

- an idempotency key;
- the expected state or repository generation;
- actor type and stable actor ID;
- provenance such as API client, automation run, or user session;
- an optional external ID for reconciliation.

The API serves an OpenAPI 3.1 document at `GET /api/v1/openapi.json`, with structured validation, RFC 9457 problem responses, cursor pagination on list endpoints, and signed retryable webhooks. Webhook management (`POST`/`GET /api/v1/webhooks`, `GET /api/v1/webhooks/{webhookId}`, `POST /api/v1/webhooks/{webhookId}/revoke`, `GET /api/v1/webhooks/{webhookId}/deliveries`) is session-only for active instance owners and administrators; API keys are refused with 403 `api-key-not-permitted`. Delivery is `POST /api/v1/system/webhooks/drain`. HMAC-SHA256 signatures cover `timestamp.body` as `v1=<hex>`. The OpenAPI document enumerates the live `/api/v1` handlers, including capability reissue aliases, operator evidence/PDF aliases, signature-asset upload, and public `?format=pdf`. Stable events include `envelope.created`, `draft.revision_created`, `envelope.ready`, `envelope.fields_placed`, `envelope.sent`, `recipient.viewed`, `recipient.signed`, `recipient.declined`, `recipient.approved`, `recipient.capability_reissued`, `envelope.completed`, `envelope.completion_artifact_published`, `envelope.voided`, and `envelope.expired`.

## Rust CLI architecture (`signkit`)

The first production-quality CLI slice lives in `cli/` with binary name `signkit` (see [cli.md](../cli.md)). Built for automated, non-interactive agent integration, its design rules are:

- **Truthful scope exposure:** System capabilities, JSON envelope inspection (`list`, `get`, `draft`, `deliveries`, `completion-artifact`, `pdf-seal-status`), immutable evidence/PDF download (`evidence`, `pdf`, `pdf-seal-download`), explicit instance-seal requests (`pdf-seal-request`), API-key authoring/send mutations, ordered PDF upload/document removal, bounded DOCX import/export, and separate recipient-capability review/viewed/sign/approve/decline commands. API-key, instance, webhook, and reissue management remain unexposed in the CLI.
- **Single-instance authority:** Envelope commands target the configured SignKit instance. API-key scopes are intersected with the active membership of the key owner; there is no external workspace selector.
- **Credential hygiene:** API keys are ingested solely from the `SIGNKIT_API_KEY` environment variable or `--api-key-stdin`. Command-line flags and configuration files are prohibited from holding secret material.
- **Recipient consent and authority:** Recipient commands require the recipient's own invitation capability through the CLI's dedicated secret channel. A sender API key cannot substitute. The CLI requires an explicit consent flag for state-changing recipient actions; an agent does not gain permission to silently sign merely by having access to a token. The HTTP contract and tradeoffs are recorded in [the 2026-09-25 ADR](decisions/2026-09-25-browserless-recipient-capability.md).
- **Fail-closed network posture:** Redirects are completely disabled to prevent credential leakage. Responses are strictly bounded to prevent OOM risks. Timeouts are enforced.
- **Deterministic machine interface:** Every error produces an RFC 9457 problem document to stderr; every success produces versioned JSON (`{"version": "1", "data": ...}`); exact exit codes (`0`..`12`) govern all success and failure outcomes.
- **Explicit typing:** Explicit Rust structs are used at all serialization and deserialization boundaries to eliminate type inference ambiguities.
