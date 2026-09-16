# D1 Time Travel restore runbook

Status: normative draft

Applies to the Cloudflare Workers deployment profile only. Node/Docker and Vercel use PostgreSQL, not D1; see [../deployment.md](../deployment.md) for that profile's database configuration.

## What Time Travel is

Cloudflare D1 continuously retains a rolling window of point-in-time recovery data for every database — there is no manual backup step to schedule or forget. `wrangler d1 time-travel` reads and restores from that window. Confirm the exact retention window (historically up to 30 days, but check current Cloudflare documentation and your plan) before relying on it for an incident older than that.

A Time Travel restore is a **whole-database, in-place rollback**: it replaces the live database's current state with its state at a chosen bookmark or timestamp. It does not create a side-by-side copy by default, and it does not touch R2 (see [r2-restore.md](r2-restore.md) for object storage). Treat it as destructive and irreversible without a second restore to undo it.

## Before you restore

1. **Confirm you actually need a whole-instance rollback.** One D1 database is one SignKit instance, and every mutating command is designed to fail closed rather than silently corrupt data. Before reaching for Time Travel, rule out:
   - A single bad write that a targeted, hand-written `UPDATE`/`DELETE` against the current database can correct without discarding every other write since the incident.
   - An application bug that has since been fixed and only needs its bad rows cleaned up, not a time rollback.
2. **Capture the current bookmark first, even if you intend to restore.** This gives you a way back if the restore target turns out to be wrong:
   ```sh
   wrangler d1 time-travel info <DATABASE_NAME>
   ```
   Record the bookmark it prints somewhere durable (an incident ticket, not just your terminal scrollback).
3. **Freeze writes for the duration of the incident response.** Stop the Worker's cron trigger (or otherwise pause traffic) so nothing writes to D1 between the incident and the restore — every write in that window is at risk of being silently discarded by the rollback.
4. **Decide the target point in time.** Time Travel accepts either a bookmark (preferred — exact and unambiguous) or an ISO-8601 timestamp (convenient, but resolves to "whatever bookmark was current at that instant," which is imprecise for events that happened within the same second as other writes). Prefer a bookmark captured from application logs or Cloudflare's dashboard activity log for the incident.

## Restoring

1. Re-check the exact current flags before running anything destructive — Wrangler's CLI surface for Time Travel has changed before and may change again:
   ```sh
   wrangler d1 time-travel restore --help
   ```
2. Run the restore against the target bookmark or timestamp:
   ```sh
   wrangler d1 time-travel restore <DATABASE_NAME> --bookmark=<BOOKMARK>
   # or, less precisely:
   wrangler d1 time-travel restore <DATABASE_NAME> --timestamp=<ISO-8601-TIMESTAMP>
   ```
3. If your Wrangler version supports restoring into a **new** database name rather than in place, prefer that for the first attempt: it lets you inspect the restored data before committing to the rollback, and lets you diff it against the live database. Fall back to the in-place form only once you have verified the target point in time is correct.

## After you restore

1. **Reconcile D1 against R2.** D1 rows reference R2 objects by content-addressed key (derived from a SHA-256 digest) or by an explicit object key column. After a rollback:
   - Any object a restored row points to that was deleted or garbage-collected _after_ the restore point is gone from R2 and must be recovered per [r2-restore.md](r2-restore.md), or the referencing envelope/artifact is unrecoverable.
   - Any object created _after_ the restore point (uploaded by writes the rollback just discarded) is now an orphan in R2 with nothing in D1 pointing to it. This is safe by construction — content-addressed keys are immutable and orphaned objects are inert — but a subsequent orphan sweep will eventually reclaim the storage; see [../architecture/persistence.md](../architecture/persistence.md).
2. **Re-run outstanding drains.** The delivery, completion-artifact, completion-delivery, reseal-sweep, envelope-expiry, webhook, and orphan-sweep jobs (see [../deployment.md](../deployment.md#background-jobs)) are all designed to be safely re-triggered: they discover outstanding work from the current database state rather than trusting an in-memory queue, so a rollback that reverted some in-flight state is automatically picked back up. The orphan sweep will not delete objects younger than 24 hours or keys still referenced after the restore.
3. **Audit-chain continuity.** SignKit's audit events are a per-envelope hash chain (`previous_hash`/`event_hash`). A rollback that discards the tail of that chain is safe — the chain simply resumes from the restored head — but a rollback that discards only _some_ rows referencing a given envelope while leaving others (which should not happen with a whole-database Time Travel restore, since it is atomic and consistent) would not be. Time Travel restores the whole database atomically, so intra-envelope consistency is preserved; the risk is only ever "we discarded more recent history than we meant to," never "we corrupted the chain."
4. **Resume writes** (unpause the cron trigger / restart traffic) only after confirming the restored state looks correct.
5. **Write an incident note** recording the bookmark you restored to, the bookmark you captured before restoring (step 2 above), and the wall-clock window of writes that were discarded, so anyone reconciling downstream systems (mail providers, webhooks, exports) knows exactly what may be duplicated or missing.

## Testing this runbook

Because a real restore is destructive, rehearse this procedure against a disposable D1 database (create one with `wrangler d1 create <SCRATCH_DATABASE_NAME>`, apply the migrations in `migrations/d1`, write some throwaway rows, then practice steps 2–4 above) rather than the first time you need it during an incident.
