# S3-compatible object storage backup and restore runbook

Status: normative draft

Applies to the Node/Docker and Vercel deployment profiles only, which use any S3-compatible service (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`) instead of R2 — R2 is not used through its S3 endpoint on this profile; see [../deployment.md](../deployment.md) for that profile's object storage configuration and [r2-restore.md](r2-restore.md) for the Cloudflare Workers equivalent.

## What SignKit stores here, and why that matters for recovery

Every object SignKit writes through `ObjectStore.putImmutable` (draft Git archives, completion manifests/Markdown, completion PDFs, signature assets, and any future sealed evidence) is:

- **Immutable** — the application never overwrites an existing key; the S3 adapter (`src/lib/adapters/object/s3.ts`) writes with `IfNoneMatch: '*'`, so a second write to the same key fails rather than silently replacing bytes. A "new version" is always a new, differently-keyed object.
- **Content-addressed or otherwise permanently keyed** — the key is derived from the SHA-256 of the bytes it names, or is a stable per-envelope/per-recipient path written exactly once. See [../architecture/persistence.md](../architecture/persistence.md).
- **Independently verifiable** — the SHA-256 digest of every object is also recorded in PostgreSQL next to the pointer/column that references it, so a restored object can be checked byte-for-byte before anything trusts it again; see [postgres-backup-restore.md](postgres-backup-restore.md).
- **Not encrypted by SignKit before upload.** Reading the S3 adapter confirms `PutObjectCommand` uploads `object.body` as-is, with only a `sha256` metadata field attached — there is no client-side/application-level encryption step for object bytes on this profile (unlike cookies and delivery capabilities, which are sealed with `SESSION_ENCRYPTION_KEY`/`DELIVERY_ENCRYPTION_KEY` before storage — see [../deployment.md](../deployment.md)). Encryption at rest for object bytes therefore depends entirely on the bucket's own server-side encryption and access control; do not assume SignKit compensates for a bucket that has neither.

The two failure modes you are recovering from are almost always one of: **accidental or buggy deletion** of one or more objects, or **bucket-level loss** (the bucket is deleted or becomes inaccessible).

## Primary protection: bucket versioning and/or object lock

Because SignKit itself already refuses to overwrite a key, the risk this store faces in practice is deletion, not corruption-by-overwrite. If your provider supports it, enable:

- **Bucket versioning**, so a delete produces a recoverable delete marker/prior version instead of true data loss.
- **Object lock (WORM)**, if your provider offers it, as defense in depth — SignKit's own immutability guarantee is an application-level promise, not a storage-level one, so a bug, a misconfigured lifecycle rule, or direct console/API access could still delete a key that the application would never delete itself.

Confirm your specific provider's feature names and defaults; not every S3-compatible provider supports both, and some enable one only at bucket-creation time.

## Explicit backup: a cross-account/cross-provider mirror

Versioning alone is not a backup if the whole bucket, account, or provider becomes unavailable. Maintain a one-way mirror to a second bucket, ideally in a different account or a different provider than the primary, so a compromised or misconfigured primary account cannot also destroy the backup:

```sh
aws s3 sync s3://<BUCKET_NAME> s3://<BACKUP_BUCKET_NAME> \
  --endpoint-url <S3_ENDPOINT> --source-region <S3_REGION>
# or, using rclone against two S3-compatible remotes:
rclone sync primary:<BUCKET_NAME> backup:<BACKUP_BUCKET_NAME>
```

Because objects are immutable and never overwritten, an incremental "copy anything new" sync is sufficient — there is no need to reconcile diffs against existing keys, only to copy what the backup does not yet have. Verify the backup periodically by sampling keys, downloading from both the primary and backup buckets, and confirming the SHA-256 matches the digest recorded in PostgreSQL (see "Verifying restored objects" below).

If you have not set up this mirror yet, do that before you need this runbook — the rest of this document assumes one exists.

## Retention and lifecycle

How long you keep mirrored copies, prior versions (if versioning is enabled), and how aggressively any lifecycle rule expires objects is an operator policy decision that SignKit does not enforce or have an opinion on. Set a lifecycle/retention policy on both the primary and backup buckets deliberately — an over-aggressive lifecycle rule on the primary bucket is itself a source of the "accidental deletion" failure mode this runbook recovers from. Keep the backup's retention at least as long as your PostgreSQL backup retention (see [postgres-backup-restore.md](postgres-backup-restore.md)) so the two systems' recoverable history windows line up.

## Server-side encryption

Enable your provider's server-side encryption (SSE-S3, SSE-KMS, or the provider's equivalent) on both the primary and backup buckets. Since SignKit does not encrypt object bytes itself on this profile (see above), this is the only encryption-at-rest protection object bytes get; do not rely on TLS-in-transit alone. If your provider supports customer-managed KMS keys, prefer them over provider-managed keys if you need to control key custody independently of the storage provider.

## Restoring a small number of known objects

If you know exactly which keys were lost (from an incident report, from PostgreSQL rows whose `HEAD` request against the primary bucket now returns 404, or from application error logs):

1. Identify the affected keys and their expected SHA-256 digests from PostgreSQL (the `*_sha256` columns next to the object key/pointer columns — see [postgres-backup-restore.md](postgres-backup-restore.md)).
2. Copy each key from the backup bucket back into the primary bucket, preserving the exact key:
   ```sh
   aws s3 cp s3://<BACKUP_BUCKET_NAME>/<OBJECT_KEY> s3://<BUCKET_NAME>/<OBJECT_KEY> \
     --endpoint-url <S3_ENDPOINT>
   ```
3. Verify: download the restored object and compare its SHA-256 against the digest recorded in PostgreSQL before considering it recovered:
   ```sh
   sha256sum <DOWNLOADED_OBJECT>
   ```
4. Confirm the application can read it back through its normal path (for example, the completion-artifact or draft download routes) rather than only checking the raw object.

## Restoring after full bucket loss

1. Create a new bucket (or recreate the original name if your provider allows immediate reuse) and update `S3_BUCKET`/`S3_ENDPOINT` if they changed. Treat the actual value as instance-specific configuration outside this repository.
2. Bulk-copy everything from the backup bucket into the new bucket:
   ```sh
   aws s3 sync s3://<BACKUP_BUCKET_NAME> s3://<NEW_BUCKET_NAME> --endpoint-url <S3_ENDPOINT>
   ```
3. Spot-check a representative sample of restored objects against their PostgreSQL-recorded SHA-256 digests — a corrupted or truncated sync can produce the right object count with wrong bytes.
4. If the backup itself is stale (replication broken for a period before the incident was noticed), objects written after the last good backup are unrecoverable from it. Identify the affected PostgreSQL rows by `created_at`/`updated_at` timestamps so the application can report a clear, honest error to affected users rather than silently serving corrupted or missing evidence.

## After restoring: reconcile against PostgreSQL

If the incident also required a PostgreSQL restore, restore PostgreSQL first and reconcile the S3-compatible store second — see [postgres-backup-restore.md](postgres-backup-restore.md#after-restoring-postgresql-first-then-reconcile-s3) for the full justification. In short: orphaned objects in S3 are inert by construction (content-addressed, never referenced again), while a live PostgreSQL database holding rows that reference objects missing from S3 immediately surfaces as broken evidence to real requests — so restoring the referencing side first, then repairing storage to match, never leaves the system in the second, worse state. If PostgreSQL was never affected, simply restore S3 objects to match what PostgreSQL currently references, as described above.

Once restored, re-run the relevant background drains (see [../deployment.md#background-jobs](../deployment.md#background-jobs)) so any work that depended on now-restored objects proceeds normally, and write an incident note recording exactly which keys were restored, from which backup snapshot/timestamp, and which (if any) objects were confirmed permanently unrecoverable.

## Testing this runbook

Rehearse against a disposable bucket: create `<SCRATCH_BUCKET_NAME>`, write a handful of throwaway objects, delete one deliberately, and practice the single-object restore steps above before you need them during a real incident. Do this on the same schedule as the PostgreSQL restore rehearsal in [postgres-backup-restore.md](postgres-backup-restore.md#restore-rehearsal) so both halves of the system stay exercised together.
