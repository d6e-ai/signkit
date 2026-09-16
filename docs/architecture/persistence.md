# Persistence

SignKit supports PostgreSQL 18 for Node deployments and D1 for Cloudflare Workers. Each deployment database is one complete SignKit instance.

## Identity and ownership

`instance_member` is keyed by the d6e-auth subject and stores only local role, status, and timestamps. `instance_bootstrap` records the first owner claim. Invitations bind a verified email to a future local member.

Every envelope has a required `created_by_user_id` foreign key to `instance_member`. Every API key has a required `owner_user_id` foreign key to the member that created it. There is no separate tenant table, instance id column, selector, or API-key grant table.

## Envelope data

SQL stores envelope state, recipient routing, field placement and values, immutable command receipts, delivery outboxes, webhook state, and the audit chain. Large immutable bytes live behind `ObjectStore` in S3-compatible storage or R2.

Draft revisions are gzip-compressed Git archives. Uploaded PDFs and derived PDFs are stored as objects; Git tracks the ordered document manifest and content digests rather than embedding uploaded binary documents.

Object keys are namespaced by envelope and content digest. Rows retain SHA-256 digests and sizes so restored bytes can be checked before use.

## Concurrency and evidence

Mutations use expected generations or expected states plus `Idempotency-Key` receipts. PostgreSQL uses explicit transactions and row locks. D1 uses command tables and rollback triggers to publish related state atomically.

Audit events are append-only and use hash version 3. The preimage includes the hash version, envelope id, sequence, event type, actor type and id, timestamp, payload, and previous hash.

## Migration policy

The D1 and PostgreSQL migration sets describe a fresh database. The 2026-09-16 single-instance change deliberately rewrote the pre-release histories; databases created from older releases must be recreated rather than upgraded in place. See [the ADR](decisions/2026-09-16-single-instance-authorization.md).
