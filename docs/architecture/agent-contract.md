# Agent-first contract

Status: mixed — the Rust CLI read scope described here is implemented; OpenAPI 3.1, webhooks, and the full command set below are aspirational

The first-party UI calls the same versioned application API available to agents. Core commands are create envelope, add documents, commit draft, add recipients, place fields, send, sign/approve/decline, read status, and export evidence.

Every mutation requires:

- an idempotency key;
- the expected state or repository generation;
- actor type and stable actor ID;
- provenance such as API client, automation run, or user session;
- an optional external ID for reconciliation.

The API will use OpenAPI 3.1, structured validation, RFC 9457 problem responses, cursor pagination, and signed retryable webhooks. Stable events include `draft.revision_created`, `envelope.ready`, `envelope.fields_placed`, `envelope.sent`, `recipient.viewed`, `recipient.signed`, `recipient.declined`, `recipient.approved`, `recipient.capability_reissued`, `envelope.completed`, `envelope.completion_artifact_published`, `envelope.voided`, and `envelope.expired`.

## Rust CLI architecture (`signkit`)

The first production-quality CLI slice lives in `cli/` with binary name `signkit` (see [cli.md](../cli.md)). Built for automated, non-interactive agent integration, its design rules are:

- **Truthful scope exposure:** System capabilities, JSON envelope inspection (`list`, `get`, `draft`, `deliveries`, `completion-artifact`), API-key authoring/send mutations, and bounded DOCX import/export. API-key and instance management remain unexposed in the CLI.
- **Mandatory explicit organization selection:** The organization selector is required for all envelope commands and is never inferred.
- **Credential hygiene:** API keys are ingested solely from the `SIGNKIT_API_KEY` environment variable or `--api-key-stdin`. Command-line flags and configuration files are prohibited from holding secret material.
- **Fail-closed network posture:** Redirects are completely disabled to prevent credential leakage. Responses are strictly bounded to prevent OOM risks. Timeouts are enforced.
- **Deterministic machine interface:** Every error produces an RFC 9457 problem document to stderr; every success produces versioned JSON (`{"version": "1", "data": ...}`); exact exit codes (`0`..`8`) govern all success and failure outcomes.
- **Explicit typing:** Explicit Rust structs are used at all serialization and deserialization boundaries to eliminate type inference ambiguities.
