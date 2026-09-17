# ADR: recipient contacts are explicit private member projections

Date: 2026-09-17

## Status

Accepted.

## Context

Repeated recipient entry is slow, but silently mining envelope history would convert immutable agreement evidence into an undeclared directory. A shared instance or organization address book would also introduce authorization and lifecycle relationships that SignKit does not currently model.

Search terms are themselves contact PII. A conventional `GET ?q=` endpoint would place names and email fragments in URLs, browser history, reverse-proxy logs, and traces even when the response is correctly owner-scoped.

## Decision

SignKit stores contacts as UUIDv7-keyed projections owned by the verified d6e-auth subject of one active local `instance_member`. Ownership is never caller-selectable. D1 and PostgreSQL enforce equivalent owner, normalization, uniqueness, name/email/UUID ordering, pagination, optimistic-concurrency, and replay rules.

Contacts are saved only through an explicit sender action. Authoring and send commands never infer or retain them. Selecting a contact copies name, normalized email, and preferred locale into a recipient draft but does not control role or routing order. Later contact changes do not rewrite any envelope record or evidence.

List uses `GET /api/v1/contacts` with non-PII cursor and limit parameters. Search uses `POST /api/v1/contacts/search` with a bounded strict JSON body so search PII stays out of URLs and cursors. Create, full replacement, and delete are session-only idempotent mutations; replacement and deletion require the current version.

API keys, recipient capabilities, and recipient sessions have no contact authority. Names, email addresses, and search terms do not enter audit payloads, logs, problem details, idempotency receipts, or cursors. Unknown and cross-owner identifiers are indistinguishable.

Management remains embedded in recipient authoring and no primary Contacts sidebar item is added.

## Consequences

- Each member gets a private reusable address book without creating organization-sharing semantics.
- Search is a POST read and must never be treated as a mutation or require an idempotency key.
- Clients must copy selected fields rather than retain a live contact-to-recipient link.
- D1 and PostgreSQL integration tests must exercise the same adversarial ownership, normalization, search, cursor, concurrency, and replay matrix.
- Shared directories, imports, synchronization, CRM integration, phone and postal fields, and contact groups remain future work.
