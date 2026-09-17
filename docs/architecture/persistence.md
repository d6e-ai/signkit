# Persistence

SignKit supports PostgreSQL 18 for Node deployments and D1 for Cloudflare Workers. Each deployment database is one complete SignKit instance.

## Identity and ownership

`instance_member` is keyed by the d6e-auth subject and stores local role, status, timestamps, plus nullable display-name and email snapshots copied from that member's verified d6e-auth principal. The snapshots only label the member-management UI: they may be stale, are refreshed best-effort from the member's own session, and never participate in authorization. `instance_bootstrap` records the first owner claim. Invitations bind a verified email to a future local member.

Every envelope has a required `created_by_user_id` foreign key to `instance_member`. Every API key has a required `owner_user_id` foreign key to the member that created it. There is no separate tenant table, instance id column, selector, or API-key grant table.

Every recipient contact has a required `owner_user_id` foreign key to `instance_member`. Its UUIDv7 identifier, normalized email, display name, preferred locale, optimistic-concurrency version, and timestamps are an owner-scoped projection. The unique key is `(owner_user_id, normalized_email)`, so two members may save the same mailbox while one member cannot keep duplicate live contacts.

## Envelope data

SQL stores envelope state, recipient routing, field placement and values, immutable command receipts, delivery outboxes, webhook state, and the audit chain. Large immutable bytes live behind `ObjectStore` in S3-compatible storage or R2.

Draft revisions are gzip-compressed Git archives. Uploaded PDFs and derived PDFs are stored as objects; Git tracks the ordered document manifest and content digests rather than embedding uploaded binary documents.

Object keys are namespaced by envelope and content digest. Rows retain SHA-256 digests and sizes so restored bytes can be checked before use.

## Concurrency and evidence

Mutations use expected generations or expected states plus `Idempotency-Key` receipts. PostgreSQL uses explicit transactions and row locks. D1 uses command tables and rollback triggers to publish related state atomically.

Contact replacement and deletion use `expectedVersion`; create, replacement, and deletion use idempotency receipts that contain request fingerprints and non-PII result evidence only. D1 and PostgreSQL must produce equivalent owner checks, normalization, uniqueness, opaque not-found behavior, cursor ordering, and replay outcomes. Contact deletion changes only the contact projection and never cascades to envelope recipients or immutable evidence.

Audit events are append-only and use hash version 3. The preimage includes the hash version, envelope id, sequence, event type, actor type and id, timestamp, payload, and previous hash.

## Migration policy

The D1 and PostgreSQL migration sets describe a fresh database. The 2026-09-16 single-instance change deliberately rewrote the pre-release histories; databases created from older releases must be recreated rather than upgraded in place. See [the ADR](decisions/2026-09-16-single-instance-authorization.md).
