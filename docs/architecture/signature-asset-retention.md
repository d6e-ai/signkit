# Signature asset retention

How drawn signature and initials assets survive concurrent orphan collection. The decision record is `docs/architecture/decisions/2026-10-11-signature-asset-retention-ledger.md`.

## Model

`signature_asset` holds one row per exact scope, `(envelope_id, recipient_id, sha256)`, which is the only scope a `sig:sha256:` value can name.

| State     | Entered by                                                                        | Leaves to          |
| --------- | --------------------------------------------------------------------------------- | ------------------ |
| `pending` | upload registration (before the put), refreshed by re-upload and by fresh signing | `bound`, `retired` |
| `bound`   | publication of a field value naming it; legacy backfill                           | never              |
| `retired` | orphan sweep retirement; abandoned-registration pass                              | never              |

Both dialects enforce the following in the database:

- A live (`pending`/`bound`) row's recipient must belong to its envelope. D1 uses a trigger; PostgreSQL uses a composite FK on generated `owner_*` columns that are NULL only for tombstones. A `retired` tombstone needs no live parent.
- Only `pending` rows may change. Scope columns are immutable.
- Inserting a `field_value` that names a `retired` row aborts the write, and naming a `pending` or missing row binds it.

## Flows

Upload (`SignatureAssetApplication.store`):

1. Validate the PNG, then call `registerPending`. A `retired` result returns `expired`.
2. Call `putImmutable`. On any failure, read the object back and accept only bytes that hash to the key. This covers the duplicate-put rejection on both R2 and S3, and puts whose response was lost.

Fresh signing (`RecipientSignedApplication.sign`):

1. `checkFresh` touches each referenced `pending` row. `retired` means `signature_asset_expired`; `missing` (legacy) continues.
2. The object is read back and verified as before.
3. `publishSign` binds the rows in the same D1 batch or PostgreSQL transaction as the field values, audit events, and receipt. A `retired` row rolls the whole publication back, and the result is classified from the ledger row.

Replay is proven from the durable receipt only and never touches assets or the ledger.

Orphan sweep (`OrphanCollector.sweep`):

1. Aged, unreferenced `signature-assets/` keys go through `retireOrphans(scopes, now, now - grace)` in chunks of at most 100, and only `retired` results are deleted. Retirement, which may be a tombstone for a key whose owner no longer exists, commits before that chunk's `deleteMany`.
2. If the delete fails, the sweep throws before advancing the checkpoint, so the next sweep re-lists the key and deletes it, because retirement is idempotent.
3. Abandoned registrations go through `listPendingBefore` (bounded at 25) and then `head`. Those whose object is absent are retired by one `retireAbandonedRegistrations` call, guarded by the same cutoff.
4. `dryRun` uses `previewRetirements` and counts abandoned registrations without writing.

## D1 statement budget

D1 counts every statement, batched or not, against its per-invocation query limit: 50 on Free and 1,000 on Paid. Ledger sweep calls are therefore bulk. Each one takes at most 100 scopes and runs a constant number of statements. `retireOrphans` runs 2, while `previewRetirements`, `listPendingBefore`, and `retireAbandonedRegistrations` run 1 each. An empty batch runs none.

On D1 the collector runs under `D1_ORPHAN_SWEEP_STATEMENT_BUDGET`:

- At most 40 statements per sweep, leaving 10 for the rest of the invocation.
- Fixed overhead of 4 statements: checkpoint read and write, plus the pending listing and bulk retirement of abandoned registrations.
- Up to 6 statements per 100-key chunk: 4 for the reference lookup and 2 for the bulk retirement or preview.

Each list page holds only as many keys as the remaining budget can fully process, so one route sweep handles at most 600 keys. The checkpoint then resumes immediately after the last processed key, and the next sweep continues from there. A delete failure still throws before the checkpoint write, so the same keys are retried, at the same per-chunk cost even when they are already retired. PostgreSQL runs without a statement budget.

## Ordering argument

- A touch committed before retirement moves `pending_touched_at` past the cutoff, so the guarded retirement matches nothing.
- A retirement committed before the touch leaves `checkFresh` reporting `retired`, and publication fails closed even when the read happened earlier. That covers legacy rows, which were never touched.
- On PostgreSQL, the publication upsert and the retirement both lock the same row (or unique-index entry), so whichever commits second observes the first. On D1, writes are serialized, and the bind runs inside the publication batch.
- A retired key never reopens. Any delete, however late, can only hit a key no committed field value references.
