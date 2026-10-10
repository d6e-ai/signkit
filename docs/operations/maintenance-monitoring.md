# Maintenance drain/sweep monitoring

Status: operational runbook for the scheduled drain/sweep dispatcher and the maintenance health read

Every protected drain/sweep endpoint (`/api/v1/system/**/drain`, `**/reseal-sweep`,
`objects/orphan-sweep`) returns a bounded batch result: counts such as `claimed`,
`delivered`, `retryableFailed`, `permanentlyFailed`, and `integrityFailed`, plus a
per-item `outcomes`/`items` array. The per-item array is never logged anywhere in
this system — it can carry delivery/job identifiers — but the aggregate counts are
load-bearing operational signal, because a drain can return HTTP 200 while some of
its items failed.

## What gets logged, and when

Each drain/sweep HTTP handler — not just the Cloudflare scheduler that calls it —
logs its own batch outcome exactly once, right before it returns. That makes the
telemetry portable: it is correct whether the handler is invoked by the Cloudflare
Cron Trigger, a Node-based system cron hitting the same route over plain HTTP, or a
manual probe. Three structured, single-line JSON events cover every run:

| Event                                   | When                                                                                                                                                         | Fields                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `scheduled_maintenance_batch_completed` | The handler's own batch result has every failure-like count at zero.                                                                                         | `job`, `durationMs`, and only the known count fields present in the batch result |
| `scheduled_maintenance_batch_failed`    | The handler's own batch result reports a non-zero failure-like count (`failed`, `retryableFailed`, `permanentlyFailed`, `integrityFailed`, `unrecoverable`). | `job`, `durationMs`, and only the known count fields present in the batch result |
| `scheduled_maintenance_failed`          | The dispatch itself failed: secret missing, fetch threw, or a non-handled non-2xx.                                                                           | `job`, `code`, `status?`, `durationMs`                                           |

`scheduled_maintenance_batch_completed` is logged at a low-noise, non-alerting
severity (`console.log`, not `console.error`) — it is a liveness/latency signal,
not an incident. `scheduled_maintenance_batch_failed` is `console.error`, suitable
for alerting. A handled failure (the drain already reported it, signalled via the
`x-signkit-maintenance-failure-code` response header) is not logged again, to
avoid duplicate alerts for the same incident.

Every observed response carries an internal `x-signkit-maintenance-batch-observed`
header. The Cloudflare scheduler checks this marker and, when present, never
re-decodes the body — this is what keeps the telemetry single-sourced instead of
risking a duplicate log from both the handler and the dispatcher. For any response
that somehow lacks the marker, the scheduler falls back to its own bounded decode
of the body; if that body is missing, malformed, or over the size bound, it logs
`scheduled_maintenance_batch_summary_unavailable` (`console.warn`) exactly once
rather than staying silent — an unreadable batch result is itself an operational
signal.

All of the above, and every drain/sweep route's own resolution/processing-failure
log (`*_drain_failed`, `*_drain_resolution_failed`, and so on), only ever include
an `event` name and either a bounded count summary or `message: error.name`. Raw
error messages, object keys, emails, tokens, receipts, and row IDs are never
logged by any of this.

To alert on this in practice, watch your log sink for `scheduled_maintenance_batch_failed`
or `scheduled_maintenance_failed`. In Cloudflare, that means a Workers Logs /
Logpush filter on
`event:"scheduled_maintenance_failed" OR event:"scheduled_maintenance_batch_failed"`.

## Maintenance health read

`GET /api/v1/system/maintenance/health` is a read-only snapshot of every durable
maintenance queue, independent of whatever the most recent drain run claimed. It
answers the question the logs above cannot: "how old is the oldest thing still
waiting, and how many rows have given up for good?" — even if the scheduler
itself were disabled or misconfigured.

It is authenticated the same way as every drain route: a bearer token equal to
the instance's `DELIVERY_WORKER_SECRET`. There is no separate credential.

```sh
read -rs SIGNKIT_DELIVERY_WORKER_SECRET
printf '\n'
{
  printf 'header = "Authorization: Bearer %s"\n' "$SIGNKIT_DELIVERY_WORKER_SECRET"
  printf 'header = "Accept: application/json"\n'
} | curl --fail-with-body --silent --show-error --config - \
  "${SIGNKIT_ORIGIN}/api/v1/system/maintenance/health"
unset SIGNKIT_DELIVERY_WORKER_SECRET
```

Response shape:

```json
{
	"queues": [
		{
			"queue": "pdf_seal",
			"pendingCount": 2,
			"oldestPendingAgeSeconds": 9000,
			"oldestOverdueAgeSeconds": 143,
			"permanentlyFailedCount": 0
		}
	]
}
```

- `queue` is one of `delivery`, `instance_invitation_delivery`,
  `completion_delivery`, `completion_artifact`, `docx_conversion`, `pdf_seal`,
  `webhook_delivery`.
- `pendingCount` counts rows still actionable: pending, currently claimed
  (`processing`), or failed-but-retryable — including a retry delayed into the
  future. A delayed retry still counts here even though it is not yet due.
- `oldestPendingAgeSeconds` is the **true lifetime age** (since the row's
  `created_at`) of the oldest pending row, or `null` when `pendingCount` is 0.
  Unlike a field keyed off `available_at`, this never resets when a retry is
  scheduled — a row stuck retrying for hours cannot look freshly created here.
  For `webhook_delivery`, which has no `created_at` column, the age uses the
  immutable triggering audit event's `occurred_at`; a retry does not reset it.
- `oldestOverdueAgeSeconds` is the age (since `available_at`) of the oldest
  pending row that is actually **due right now** (`available_at <= now`), or
  `null` when nothing is due — including when every pending row is a retry
  delayed into the future. A `processing` row's `available_at` stays frozen at
  the time it became claimable, so a lease stuck past its retry window also
  surfaces here. A number that keeps growing across polls, faster than the
  primary cron's one-minute period, means that queue is not draining.
- `permanentlyFailedCount` counts rows that have given up retrying
  (`status = 'failed'` and not retryable). These need a human, not a retry.

A non-null timestamp that fails to parse (a data integrity problem, not an empty
queue) makes the whole read fail closed: the endpoint returns `503` and logs
`maintenance_health_query_failed` rather than ever reporting a corrupted row as a
healthy `null` age.

Poll this on whatever interval your external monitoring already uses (a minute or
more is reasonable, since it runs one bounded read-only query against the same
database every drain route already uses). No row identifier, payload, or error
message is ever included in the response.

### A minimal polling example

The snippet below polls the endpoint and exits non-zero if any queue has a
permanent failure or has been overdue for more than ten minutes — wire its exit
code into whatever alerting your external monitoring already runs on a cron.
It reads the same bounded JSON this document describes above and nothing else.

```sh
read -rs SIGNKIT_DELIVERY_WORKER_SECRET
printf '\n'
response="$(
  { printf 'header = "Authorization: Bearer %s"\n' "$SIGNKIT_DELIVERY_WORKER_SECRET"; } |
    curl --fail-with-body --silent --show-error --config - \
      "${SIGNKIT_ORIGIN}/api/v1/system/maintenance/health"
)"
unset SIGNKIT_DELIVERY_WORKER_SECRET

echo "$response" | jq -e '
  [.queues[] | select(.permanentlyFailedCount > 0 or (.oldestOverdueAgeSeconds // 0) > 600)]
  | length == 0
' >/dev/null
```
