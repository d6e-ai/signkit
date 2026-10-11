# Signature asset retention ledger

Date: 2026-10-11

Status: Accepted

## Context

Drawn signature and initials PNGs are stored as content-addressed, envelope- and recipient-scoped objects (`signature-assets/v1/envelopes/<envelopeId>/recipients/<recipientId>/sha256/<hex>.png`) and referenced from a signed field value as `sig:sha256:<64hex>` (issue #219).

The orphan collector checked `field_value` references and then called `deleteMany`. Fresh signing read the object back, hash-verified it, and only then called `publishSign`. Nothing ordered those two check-then-act sequences. A sweep that ran after the signer's verification but before publication could delete an aged, still-unreferenced upload whose reference was about to be committed, leaving a signed field value that names a missing object. The race reproduced on workerd D1/R2 and on PostgreSQL 18/S3.

Neither R2 nor S3 has a cross-store transaction with the database. Both reject a second immutable put to an existing key, so a re-upload of identical bytes cannot "refresh" the object either.

## Decision

- Add a provider-neutral `signature_asset` ledger in the database, keyed by the exact scope a reference can name: `(envelope_id, recipient_id, sha256)`. Its states are `pending -> bound` and `pending -> retired`. `bound` and `retired` are final, and scope columns never change. Migrations are D1 `0054_signature_asset_ledger.sql` and PostgreSQL `0050_signature_asset_ledger.sql`.
- The database enforces exact scoped ownership for live (`pending`/`bound`) rows only: a D1 `BEFORE INSERT` trigger, and in PostgreSQL a composite foreign key from generated `owner_*` columns to `recipient(envelope_id, id)`, which are NULL only for `retired` rows. A `retired` tombstone needs no live parent, so there are no plain foreign keys to `envelope` or `recipient`. Scope columns are immutable and `retired` is final, so a tombstone can never become live and skip the owner check. A `BEFORE UPDATE` guard trigger enforces the state machine in both dialects.
- Upload registers or touches the `pending` row before the immutable put. A `retired` row refuses the upload (`409 urn:signkit:problem:signature-asset-expired`) rather than resurrecting the key. When the put fails, the existing object is read back, and it is reused only if its bytes hash to the key. That holds for R2 and S3 alike, and provider error text is never parsed.
- Fresh signing touches each referenced `pending` row before reading the object, so a sweep whose cutoff predates the touch can no longer retire it. Publication binds every referenced row atomically with the field values, audit events, and command receipt. On D1 that happens in the same batch, through an `AFTER INSERT` trigger on `field_value`. On PostgreSQL it is a row-locked upsert in the same transaction, backed by an equivalent trigger for any other writer. A `retired` row aborts the publication. The store classifies that from the ledger row itself, and the API returns `409 urn:signkit:problem:recipient-signed-signature-asset-expired` with nothing written.
- The collector commits retirement in the database before any delete. The retirement statement re-checks the exact scoped `field_value` reference and the pending-touch cutoff in the same statement (D1) or row-locked transaction (PostgreSQL). If the pending touch lands first, the collector cannot retire. If retirement lands first, the fresh publish cannot commit. Every canonical key selected for deletion is backed by a committed `retired` tombstone, including a legacy object whose recipient does not (or no longer) exist. The non-resurrection guarantee therefore does not depend on owners never being created or restored: an owner that appears while a stale deletion is still in flight finds the key retired at registration, reuse, and publication alike.
- Legacy objects with no row are handled atomically. One statement inserts `bound` when an exact field value already names the object and `retired` otherwise. The migrations also backfill every existing signature and initials reference as `bound`.
- A bounded, DB-driven pass retires abandoned `pending` registrations older than the grace period whose object is absent. `dryRun` performs only read-only previews.
- Sweep-side ledger operations are bulk calls of at most 100 scopes, each a constant number of statements. On D1 the collector runs under an explicit statement budget (40 of the Free plan's 50 per invocation): it lists only what it can fully process and checkpoints after it, so collection always makes durable progress instead of exceeding the query limit and repeating the same page.
- Without a wired ledger, the collector never deletes `signature-assets/` objects. Other object kinds behave as before.
- The client resets cached drawn references only on the explicit expired problem types. On an upload refusal it retries once with the same canvas bytes plus a `tEXt` nonce chunk: identical pixels, fresh hash. On a sign refusal it clears only drawn references and mints a new Idempotency-Key. Ambiguous network failures keep the original values and key.

## Consequences

The delete-after-verify race is closed in both dialects without a cross-store transaction. A late or stale delete can only ever target a `retired` key, and a retired key can never be bound again, so it cannot destroy a referenced asset.

Tombstones (`retired` rows) are permanent and are not purged automatically. They are small, and purging one would reopen exactly the resurrection window this design closes.

A signer whose identical bytes were retired must produce new bytes. In practice that means re-drawing, or the client's single nonce retry. `sig:sha256:` values, object keys, and PDF, audit, and receipt formats are unchanged, and idempotent sign replay never touches assets.

Rollout requires pausing or draining collectors that run old code before the new code and migration take effect. A pre-ledger collector still deletes without consulting the ledger. See `docs/operations/signature-asset-retention.md`.

## Alternatives considered

- **Re-check references immediately before `deleteMany`:** rejected. That narrows the window but cannot close it without a shared transaction.
- **Copy the asset into the signing transaction or the executed PDF only:** rejected. It changes stored formats and still leaves the object store and database unordered.
- **Lease or lock objects in the provider:** rejected. R2 and S3 have no common primitive for it, and the decision must stay provider-neutral.
- **A generic background job framework for GC:** rejected as out of scope. Bounded passes inside the existing sweep suffice.
- **Allow `retired -> pending` when the same bytes are re-uploaded:** rejected. A delayed delete issued before the reopen would then destroy a freshly bound asset.
