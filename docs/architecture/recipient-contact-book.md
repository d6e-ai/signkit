# Recipient contact book

Status: accepted design for Issue #99

The contact book reduces repeated recipient entry without turning envelope history into a directory. A contact is a private convenience projection owned by one active local instance member. It is not an envelope recipient, an instance-wide address book, a d6e organization record, or a source of recipient authority.

## Data model and invariants

A contact exposes:

- a SignKit-minted UUIDv7 `id`;
- a normalized `email`;
- `name`, the display name copied into recipient authoring;
- `locale`, the preferred recipient locale (`en` or `ja`);
- an optimistic-concurrency `version`; and
- canonical `createdAt` and `updatedAt` timestamps.

The durable row additionally carries `owner_user_id`, derived only from the verified d6e-auth session subject. No API input may name an owner, tenant, instance, or organization. One owner may have only one live contact for a normalized email; different owners may save the same email independently. Email validation and trim/lower-case normalization are the same contract used when an envelope recipient graph is prepared.

D1 and PostgreSQL implement the same constraints and outcomes. Both providers must agree on normalization, uniqueness, active-membership checks, owner-scoped cursor resolution, deterministic name/email/UUID ordering, optimistic version conflicts, idempotent replay, and opaque handling of unknown or cross-owner identifiers. Provider error strings are not public classifications.

Deleting a contact deletes only this convenience projection. Existing draft values already copied from it, ready or sent recipient rows, audit events, deliveries, completion artifacts, and immutable evidence remain unchanged. Recreating the same normalized email after deletion is allowed.

## Authorization and privacy

All contact operations require a verified d6e-auth browser session and a currently active local `instance_member`. Owner, admin, and member roles have equal access to their own contact book and no access to another member's rows.

The surface rejects SignKit API keys and recipient capabilities. A disallowed bearer cannot ride an otherwise valid browser cookie into the contact API. Recipient-session cookies authorize only their envelope-scoped signing surface and grant no contact authority.

Names, email addresses, and search text are excluded from audit payloads, structured logs, problem details, idempotency receipts, request URLs, and cursors. Unknown and cross-owner contact IDs return the same not-found status and problem shape. Successful and problem responses are not cacheable.

## HTTP contract

`GET /api/v1/contacts` lists the caller's contacts with only `cursor` and `limit` query parameters. `POST /api/v1/contacts/search` performs bounded search with a strict JSON body `{ query, cursor?, limit? }`. Search is a body-based read intentionally: putting a name or email fragment in a query string would copy private contact data into browser history, proxies, and routine access logs.

Both operations return `{ items, nextCursor }`. Pagination orders by normalized searchable name, email, and UUID tie-breaker. A cursor carries only the last owner-scoped contact UUID; the server resolves its sort position without exposing the name, email, or query. Search input is length-bounded and passed to parameterized provider queries. SQL wildcard characters and metacharacters are data rather than control syntax.

Mutations are:

- `POST /api/v1/contacts` with `{ email, name, locale }`;
- `PUT /api/v1/contacts/{contactId}` with `{ email, name, locale, expectedVersion }`; and
- `DELETE /api/v1/contacts/{contactId}` with `{ expectedVersion }`.

All request bodies are bounded and strict. Each mutation requires `Idempotency-Key`. Creation returns `201 { contact }`, or `200 { contact }` with `Idempotency-Replayed: true` for a safe replay. Replacement returns `200 { contact }`; deletion returns `200 { deleted: { id, deletedAt } }`. A safe replacement or deletion replay also sets `Idempotency-Replayed: true`. Reusing a key for a different canonical request is a conflict. Receipt evidence contains contact identifiers, versions, timestamps, and request hashes, never names or email addresses.

## Authoring integration

The recipient authoring surface uses an installed shadcn-svelte Command/Combobox-style control. Selecting a contact copies only `name`, normalized `email`, and preferred `locale` into the selected recipient draft. Recipient role and routing order remain under the sender's control.

Saving is a separate explicit action. Typing a recipient, preparing an envelope, sending it, or receiving a historical envelope never creates or updates a contact. Lightweight create, replace, and delete management stays inside the recipient authoring surface; there is no primary Contacts sidebar destination.

The combobox and management dialog support keyboard navigation, visible focus, appropriate combobox/listbox/dialog semantics, and localized English and Japanese copy. Search requests are bounded, stale responses cannot replace newer results, and API failures leave the recipient draft intact.

## Non-goals

The MVP has no shared organization directory, contact inference from historical envelopes, directory synchronization, CSV or vCard import, CRM integration, phone or postal fields, groups, API-key automation, or top-level Contacts navigation.
