# PostgreSQL backup and restore runbook

Status: normative draft

Applies to the Node/Docker and Vercel deployment profiles only, which use PostgreSQL 18 (`DATABASE_URL`, via the `postgres` npm package) instead of D1; see [../deployment.md](../deployment.md) for that profile's database configuration and [d1-time-travel-restore.md](d1-time-travel-restore.md) for the Cloudflare Workers equivalent.

## What SignKit stores in PostgreSQL, and why that matters for recovery

Every table SignKit writes is scoped by `organization_id`, so a restore can in principle be limited to the rows a single tenant needs — though PostgreSQL's own backup and restore primitives operate on the whole database or cluster, not per-row, so scoping a _restore_ to one tenant in practice means restoring into a scratch database and copying out only the affected rows (see [../architecture/persistence.md](../architecture/persistence.md)). SQL rows never hold object bytes directly: any row that references an object in the S3-compatible store (draft archives, completion manifests/Markdown, completion PDFs, signature assets) carries the object's key or a derived path alongside a `*_sha256` column recording the SHA-256 digest of the bytes it points to. That digest is what makes a restored row independently verifiable — see [s3-backup-restore.md](s3-backup-restore.md) and "Verifying restored rows" below.

## Backup strategies: logical vs. physical/WAL

Two strategies exist and they answer different questions; use both rather than picking one:

- **Logical backup (`pg_dump`/`pg_dumpall`).** A point-in-time, self-contained SQL/custom-format dump of the database's current data and schema. Cheap to store, portable across PostgreSQL versions, and easy to restore into a scratch database for inspection or rehearsal. Its granularity is "whenever you ran it" — it cannot restore to an arbitrary moment between two dumps. Prefer it as the baseline daily/hourly backup and for rehearsal drills.
- **Physical/WAL-based backup (`pg_basebackup` + continuous `archive_command`, or a managed provider's point-in-time-recovery feature).** A base backup of the data directory plus a continuously archived stream of write-ahead log segments lets you replay to _any_ point in time within the retained WAL window, not just to the moment a dump was taken. This is the strategy that matches an incident like "a bad migration ran at 14:32 UTC and we need the state at 14:31:59." Prefer it whenever the acceptable data-loss window (RPO) is smaller than your dump interval, or when a managed provider (RDS, Cloud SQL, Neon, Supabase, or equivalent) already offers continuous PITR as a checkbox feature — in which case use that instead of operating `archive_command` yourself.

Running both is not redundant: logical dumps are your fast, version-portable rehearsal target and an independent copy that survives a WAL-archive misconfiguration; physical/WAL backups are what gives you sub-dump-interval recovery precision.

## Backup encryption at rest

Neither `pg_dump` output nor a WAL archive is encrypted by PostgreSQL itself. Before a dump or WAL segment leaves the database host, either:

- Encrypt it on the host before upload (for example, pipe `pg_dump` through `gpg --symmetric` or `age` before writing it to `<BACKUP_BUCKET_NAME>`), so the operator holds the key and the storage backend never sees plaintext; or
- Rely on the storage backend's server-side encryption (SSE-S3, SSE-KMS, or the provider's equivalent) applied to the bucket or volume the dumps/WAL land in, in which case the storage provider (or a KMS key you separately control) holds the key, not SignKit.

SignKit does not perform either of these itself — it has no involvement in database backup at all. Whichever option you choose, document who holds the decryption key and rehearse decrypting a backup as part of the restore rehearsal below, not for the first time during an incident.

## Retention

How many daily/hourly logical backups and how many days of WAL you retain is an operator policy decision, not something SignKit enforces or has an opinion on. Set a retention window that satisfies your compliance and incident-response requirements (a common starting point is 7–30 days of logical backups plus enough WAL to cover your PITR window), and prune older backups on a schedule — nothing in this codebase prunes them for you. Keep the retention window at least as long as the retention window you set for the S3-compatible backup mirror in [s3-backup-restore.md](s3-backup-restore.md); a mismatch means one system can outlive the other's recoverable history, which complicates the reconciliation in "After restoring" below.

## Restoring

1. **Logical restore** (dump-granularity, most common case — a bad write, a bad migration, or validating a backup):
   ```sh
   pg_restore --clean --if-exists --dbname="<RESTORE_TARGET_CONNECTION_STRING>" <DUMP_FILE>
   ```
   Restore into a **new, scratch database first** (`createdb <SCRATCH_DATABASE_NAME>`), inspect it, and only point the application at it (or copy rows back) once you have confirmed it is correct. Never restore in place over the live database as the first attempt.
2. **Physical/PITR restore** (arbitrary point in time, self-managed):
   - Restore the most recent base backup into a fresh data directory.
   - Configure a `restore_command` pointing at the WAL archive location and set `recovery_target_time` (or `recovery_target_lsn`) to the desired point.
   - Start PostgreSQL and let it replay WAL up to the target, then confirm it has reached consistency before promoting it or pointing traffic at it.
   - On a managed provider, use its PITR restore action/API instead and supply the same target timestamp.
3. Freeze application writes (stop the host scheduler's drain calls — see [../deployment.md#background-jobs](../deployment.md#background-jobs)) for the duration of the restore so nothing writes to the live database while you validate the restored copy.

## After restoring: PostgreSQL first, then reconcile S3

If an incident requires restoring both PostgreSQL and the S3-compatible object store, **restore PostgreSQL to its target point in time first, then reconcile the S3-compatible store against it second** — the same order as [d1-time-travel-restore.md](d1-time-travel-restore.md) uses for D1/R2, and for the same underlying reason, not merely by analogy:

- S3 objects written through `ObjectStore.putImmutable` are immutable, content-addressed, and inert when orphaned: an object nothing in SQL currently references is harmless and is eventually reclaimed by the orphan sweep (see [../architecture/persistence.md](../architecture/persistence.md)). Rolling PostgreSQL back to an earlier point can leave objects created after that point orphaned in S3 — safe by construction.
- The opposite order is unsafe in a way the D1/R2 case shares but is worth spelling out: if you rolled the S3-compatible store back to an earlier state _before_ rolling PostgreSQL back, the live, still-serving PostgreSQL database (unlike a Time Travel/PITR restore, an S3 restore does not require taking the application down) would immediately hold rows that reference objects that no longer exist — dangling references surfaced to real users as broken evidence, not an inert background condition.
- Restoring PostgreSQL first collapses that window to zero: once the database is at the target point, every row it holds should reference an object that existed at that point, and the only remaining risk is that a referenced object was itself deleted afterward (by the orphan sweep, after its 24-hour grace period, or by direct data loss) — which S3 restore-from-backup as described in [s3-backup-restore.md](s3-backup-restore.md) then repairs on a per-key basis rather than requiring you to roll back the entire bucket.

Concretely: after the PostgreSQL restore completes and before resuming writes, scan the restored database for object references (the `*_sha256` columns and their paired key/path columns across the draft, completion-artifact, and document tables) and confirm each key still exists in the S3-compatible store; restore any that are missing per [s3-backup-restore.md](s3-backup-restore.md).

## Verifying restored rows against recorded SHA-256 digests

A restored row is not trustworthy until its referenced object is checked, not just its presence. For each affected row:

```sh
psql "<RESTORE_TARGET_CONNECTION_STRING>" -c \
  "SELECT id, object_key, sha256 FROM <TABLE> WHERE id = '<ROW_ID>';"
```

Fetch the object at `object_key` from the S3-compatible store, compute its SHA-256, and compare it byte-for-byte against the `sha256` column before treating the row as recovered:

```sh
sha256sum <DOWNLOADED_OBJECT>
```

Only once the digests match should the application (or an operator script) be allowed to serve that row's evidence again.

## Restore rehearsal

Practice this restore on a schedule (for example, monthly, or after every schema migration), not only during an incident, and make the rehearsal an executable script rather than a checklist someone reads:

1. Provision a disposable database: `createdb <SCRATCH_DATABASE_NAME>`.
2. Apply the migrations in `migrations/postgres` to a copy, or restore your most recent logical backup into it: `pg_restore --dbname="<SCRATCH_DATABASE_CONNECTION_STRING>" <DUMP_FILE>`.
3. Run the verification query above against a handful of known rows and confirm the digests match objects in your S3-compatible backup mirror.
4. If you operate WAL-based PITR, additionally rehearse the physical restore path end-to-end into a second scratch data directory and confirm it reaches consistency at a chosen target time.
5. Record how long each rehearsal took (base restore time plus WAL replay time) — that duration is your real recovery-time estimate, and it should inform your retention window and whether you need faster hardware or a smaller WAL replay window before the next real incident.
