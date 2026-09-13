# R2 object storage restore runbook

Status: normative draft

Applies to the Cloudflare Workers deployment profile only. Node/Docker and Vercel use an S3-compatible store instead of R2; the same principles apply, but use your provider's own backup/versioning/replication features in place of the R2-specific commands below.

## What SignKit stores in R2, and why that matters for recovery

Every object SignKit writes through `ObjectStore.putImmutable` (draft Git archives, completion manifests/Markdown, and any future sealed evidence such as a completed PDF) is:

- **Immutable** — the application never overwrites an existing key. A "new version" is always a new, differently-keyed object.
- **Content-addressed or otherwise permanently keyed** — the key is derived from the SHA-256 of the bytes it names (draft archives, completion artifacts) or is a stable per-envelope/per-recipient path that is written exactly once. See [../architecture/persistence.md](../architecture/persistence.md) and [../architecture/completion-artifacts.md](../architecture/completion-artifacts.md).
- **Independently verifiable** — the SHA-256 digest of every object is also recorded in SQL (D1/PostgreSQL) next to the pointer that references it, so a restored object can be checked byte-for-byte before anything trusts it again.

This means the two failure modes you are recovering from are almost always one of:

1. **Accidental or buggy deletion** of one or more objects (an operator error, a bad script, a bucket lifecycle rule misconfigured too aggressively, or an orphan-sweep bug that reclaimed something still referenced).
2. **Bucket-level loss** (the bucket itself is deleted or becomes inaccessible).

R2 does not currently give you the same continuous point-in-time rollback for object storage that D1 Time Travel gives you for SQL (see [d1-time-travel-restore.md](d1-time-travel-restore.md)). Confirm current Cloudflare documentation for object versioning/undelete features, since R2's feature set has expanded over time and may cover part of this by the time you read it — but do not assume it without checking, and do not treat this runbook as a substitute for an explicit backup below.

## Prerequisite: keep an explicit backup

Because R2 objects are immutable and content-addressed, the cheapest reliable backup strategy is a one-way mirror to a second bucket (ideally in a different account or provider, so a compromised or misconfigured primary account cannot also destroy the backup):

- Use `rclone` (which supports both R2 and S3-compatible endpoints) or the Cloudflare API/dashboard's bucket-to-bucket replication feature, if enabled for your account, to continuously or periodically sync `<BUCKET_NAME>` to `<BACKUP_BUCKET_NAME>`.
- Because objects are never overwritten, an incremental "copy anything new" sync is sufficient — there is no need to reconcile diffs or handle updates to existing keys.
- Verify the backup periodically by picking a sample of keys, downloading from both the primary and backup buckets, and confirming the SHA-256 matches the digest recorded in SQL.

If you have not set up an explicit backup yet, do that before you need this runbook — the rest of this document assumes one exists.

## Restoring a small number of known objects

If you know exactly which object keys were lost (for example, from an incident report, from SQL rows whose `HEAD` request against R2 now returns 404, or from application error logs), restore just those keys:

1. Identify the affected keys and their expected SHA-256 digests from SQL (the `*_sha256` columns next to the object key/pointer columns — see [../architecture/persistence.md](../architecture/persistence.md) for the relevant tables).
2. Copy each key from the backup bucket back into the primary bucket, preserving the exact key (content-addressed keys make this safe: if the bytes are wrong, the key itself would not match a re-derived SHA-256):
   ```sh
   rclone copyto backup:<BACKUP_BUCKET_NAME>/<OBJECT_KEY> r2:<BUCKET_NAME>/<OBJECT_KEY>
   ```
   or, for a single object via Wrangler:
   ```sh
   wrangler r2 object get <BACKUP_BUCKET_NAME>/<OBJECT_KEY> --file=/tmp/restore-object
   wrangler r2 object put <BUCKET_NAME>/<OBJECT_KEY> --file=/tmp/restore-object
   ```
3. Verify: compute the SHA-256 of the restored object and compare it against the digest recorded in SQL before considering the object recovered.
   ```sh
   sha256sum /tmp/restore-object
   ```
4. Confirm the application can read it back through its normal path (for example, `GET /api/v1/envelopes/{envelopeId}/completion-artifact` for a completion artifact, or the equivalent draft/PDF download route) rather than only checking the raw object.

## Restoring an entire bucket

If the bucket itself was deleted or a large, untracked swath of objects is missing:

1. Create a new bucket (or recreate the original name, if your Cloudflare account allows immediate reuse) and update `wrangler.jsonc`'s `bucket_name` binding if the name changed. Do not commit the real bucket name change without checking whether your deployment process treats it as instance-specific configuration outside this repository.
2. Bulk-copy everything from the backup bucket into the new bucket:
   ```sh
   rclone sync backup:<BACKUP_BUCKET_NAME> r2:<NEW_BUCKET_NAME>
   ```
3. Spot-check a representative sample of restored objects against their SQL-recorded SHA-256 digests (step 3 above), not just a total object count — a corrupted or truncated sync can produce the right count with wrong bytes.
4. If the backup itself is stale (for example, replication was broken for a period before the incident was noticed), reconcile the gap: objects written after the last good backup and before the incident are unrecoverable from the backup and must be treated as permanently lost. Check whether the referencing D1/PostgreSQL rows for that gap can be identified (by `created_at`/`updated_at` timestamps) so the application can report a clear, honest error to affected users rather than silently serving corrupted or missing evidence.

## After restoring

1. Re-run the relevant background drains (see [../deployment.md](../deployment.md#background-jobs)) so any work that depended on now-restored objects proceeds normally.
2. If the incident also required a D1 Time Travel restore, perform that restore first and reconcile against R2 second — see the "Reconcile D1 against R2" step in [d1-time-travel-restore.md](d1-time-travel-restore.md). Restoring R2 objects that a subsequent D1 rollback will immediately orphan again is wasted effort performed in the wrong order.
3. Write an incident note recording exactly which keys were restored, from which backup snapshot/timestamp, and which (if any) objects were confirmed permanently unrecoverable.

## Testing this runbook

Rehearse against a disposable bucket: create `<SCRATCH_BUCKET_NAME>`, write a handful of throwaway objects, delete one deliberately, and practice the single-object restore steps above before you need them during a real incident.
