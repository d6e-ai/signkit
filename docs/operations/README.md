# Operations runbooks

Status: normative draft

Operational recovery procedures for SignKit's deployment profiles: D1 (SQL) and R2 (immutable object storage) on Cloudflare Workers, and PostgreSQL and an S3-compatible store on Node/Docker (and Vercel). These runbooks are deliberately generic — no account name, account ID, production domain, database ID, bucket name, Worker name, or other instance-specific value appears here or should be added later. Fill in the placeholders (`<DATABASE_NAME>`, `<BUCKET_NAME>`, and so on) from your own deployment's configuration before running any command, and never paste live values back into this repository.

| File                                                     | Covers                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [d1-time-travel-restore.md](d1-time-travel-restore.md)   | Point-in-time recovery of the D1 database via Time Travel                                         |
| [r2-restore.md](r2-restore.md)                           | Recovering immutable objects (drafts, completion artifacts, evidence) after accidental loss on R2 |
| [postgres-backup-restore.md](postgres-backup-restore.md) | Logical and physical/WAL backup, retention, and point-in-time restore for PostgreSQL 18           |
| [s3-backup-restore.md](s3-backup-restore.md)             | Versioning, cross-account mirroring, and restore for any S3-compatible object store               |

The D1/R2 runbooks assume the reader has `wrangler` authenticated against the correct Cloudflare account and the exact resource names for the environment being recovered. The PostgreSQL/S3 runbooks assume the reader has database and bucket credentials for the environment being recovered, and use `psql`/`pg_dump`/`pg_basebackup` and a generic S3-compatible CLI (`aws s3`/`rclone`) rather than any Cloudflare-specific tooling.

Every table SignKit writes to D1/PostgreSQL is scoped by `organization_id`, and every object key SignKit writes to R2/S3 is content-addressed (the key is derived from the SHA-256 of the immutable bytes it names) or otherwise namespaced by organization and envelope. Recovery procedures below rely on both properties: a restore can be scoped to the rows/objects that actually need it, and any restored object's bytes can be independently re-verified against the SHA-256 digests already recorded in SQL before it is trusted.
