# Identifiers

Status: implemented

Every persistent SignKit-owned row identifier is a canonical lowercase RFC 9562 UUIDv7: envelopes, recipients, envelope fields, audit events (every event type, including the chained `envelope.completed` and `envelope.completion_artifact_published` events), invitation delivery intents, completion delivery grants, and API key records. Identifiers are minted by one module, `src/lib/ids/uuid-v7.ts`, which wraps the `uuid` package's RFC 9562 encoder; nothing else in the codebase mints a persistent identifier.

Identifiers are minted in the application layer before the write, not by the database. `uuidv7()` exists in PostgreSQL 18 but is deliberately not the generator: D1 has no equivalent, and commands hash, seal, and audit their identifiers before any statement runs, so the value must exist client-side for both runtimes to behave identically. Services take the generator as an injected constructor argument, and the generator itself takes an injected clock and entropy source, so unit tests can pin both.

Within one generator the sequence is strictly increasing as bytes and as text: inside a millisecond a 31-bit counter seeded from fresh entropy is incremented, and if the wall clock moves backwards the generator keeps the last emitted timestamp and keeps incrementing rather than emitting an identifier that would sort before an already-persisted row. Nothing in the system depends on ordering across processes.

The embedded timestamp is metadata and a coarse ordering hint only. It is never authorization, never tenant evidence, never trusted event time, and never a substitute for audit ordering: the audit chain's own `sequence`, `occurred_at`, and hash links remain the sole ordering and integrity evidence, and every tenant check stays an explicit `organization_id` predicate.

Identifiers are not derived from request content. Command idempotency is proven by the durable command receipt plus the normalized request fingerprint, so a replay returns the identifiers the winning attempt recorded and a rolled-back attempt simply discards its candidates. Envelope creation resolves its idempotency record first and returns the envelope that record references rather than comparing a freshly minted candidate ID.

The following are deliberately outside the rule and must never be reclassified as UUIDv7 identifiers:

- external d6e-auth organization and user identifiers, which SignKit only projects;
- caller-chosen idempotency keys: unique opaque strings. First-party browsers mint `crypto.randomUUID()` UUIDv4 as the recommended concrete format; that format is a convenience, not the contract. The server never parses UUID structure and accepts any bounded visible-ASCII key. Idempotency columns are unconstrained text, not a UUID type, so a UUIDv4 key has no database compatibility with SignKit identifiers and must never become a UUIDv7;
- opaque security material: recipient capability tokens and their hashes, `skca1_` completion access grants, and `signkit_` API key secrets keep their existing prefixed formats; OAuth state and invitation/completion lease claim tokens are minted by `src/lib/security/opaque-token.ts` as unpadded base64url over 32 Web Crypto random bytes; recipient/receipt cookie material stays in its existing session helpers — all of these keep full randomness, because a UUIDv7 carries only 74 random bits and leaks its creation time;
- content-derived values: Git commit SHAs, SHA-256 digests, content-addressed object keys, request fingerprints, and audit event hashes.

Both databases enforce the UUIDv7 rule on the columns SignKit mints. PostgreSQL uses a regular-expression check (version nibble `7`, variant nibble `8`/`9`/`a`/`b`, lowercase hexadecimal); D1 expresses the same shape with `length`, `substr`, and `NOT GLOB` because SQLite has no regular expressions. A UUIDv4 is rejected on those columns the same as any other non-v7 value: neither dialect uses a generic UUID type that would also accept v4. Columns holding external identity or arbitrary caller keys are intentionally left unconstrained, and referencing columns rely on their foreign keys rather than repeating the check.
