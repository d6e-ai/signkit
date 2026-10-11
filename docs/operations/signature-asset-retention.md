# Signature asset retention rollout and operations

This applies to D1 migration `0054_signature_asset_ledger.sql` and PostgreSQL migration `0050_signature_asset_ledger.sql`. For the design, see `docs/architecture/signature-asset-retention.md`.

## Rollout

1. Pause or drain every orphan sweep that runs pre-ledger code. That includes the scheduled Worker cron and any external caller of `POST /api/v1/system/objects/orphan-sweep`. Old collectors delete unreferenced signature assets without consulting the ledger, so they must not overlap the new protocol.
2. Apply the migration. It creates the ledger and its guards, and backfills every existing signature and initials `sig:sha256:` reference as `bound`.
3. Deploy the application code that registers, touches, and binds through the ledger.
4. Re-enable the sweep only on the new code.

If the migration is applied but old application code is still serving, uploads keep working. Publication still binds through the `field_value` trigger, and the database rejects a retired reference; the old code reports that as an integrity error rather than the new expired outcome. Keep this window short.

## Behavior to expect

- The sweep now retires before it deletes. A provider failure during the delete leaves the row `retired` and the object present. The sweep then reports `object_delete_failed`, and the next sweep deletes the object. No manual action is needed.
- `signature_retirement_failed` means the database step failed. Nothing was deleted for that batch.
- `retiredPendingRegistrations` on the collector report counts abandoned uploads that never stored an object. Each sweep examines at most 25.
- On D1, each sweep runs at most 40 statements. That leaves 10 of the Free plan's 50 queries per invocation for the rest of the request; the scheduled orphan sweep runs in its own cron invocation. Each sweep therefore processes at most 600 keys and checkpoints after the last one, so a large bucket is collected over several 5-minute runs. A full pass takes about `object count / 600` sweeps.
- Recipients whose cached drawn signature was retired see "expired" and are asked to draw again. The browser retries an upload refusal once automatically.

## Tombstones

`retired` rows are permanent and are not purged automatically. Do not delete them by hand. Deleting one lets the same bytes be registered and bound again while a delayed delete for that key could still be in flight.

Tombstones intentionally have no foreign keys. A `retired` row may name an envelope or recipient that does not exist, for example a legacy object whose recipient was removed. Such rows are expected, are not corruption, and must not be "cleaned up" by joining against `recipient`. Restoring or recreating a recipient with the same IDs does not reopen its retired keys; that recipient must upload new bytes.

## Diagnostics

All queries are read-only.

```sql
SELECT state, count(*) FROM signature_asset GROUP BY state;

-- Retired but still present in the bucket is normal until the next sweep.
SELECT envelope_id, recipient_id, sha256, retired_at
FROM signature_asset WHERE state = 'retired' ORDER BY retired_at DESC LIMIT 50;
```
