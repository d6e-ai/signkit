import {
	maintenanceBacklogAgeSeconds,
	type MaintenanceBacklogPort,
	type MaintenanceBacklogQueue,
	type MaintenanceBacklogSnapshot
} from './maintenance-backlog';

interface D1BacklogRow {
	queue: MaintenanceBacklogQueue;
	pending_count: number;
	oldest_pending_created_at: string | null;
	oldest_overdue_available_at: string | null;
	permanently_failed_count: number;
}

/**
 * One bounded, read-only round trip across every durable claim-queue table.
 * Table and column names below are fixed identifiers from this file, never
 * built from request input. A row only ever contributes to `pending` while
 * it is still actionable (pending/processing, or failed-and-retryable,
 * including `publication_ready` for `pdf_seal_job`); a `failed` row with
 * `retryable = 0` is terminal and counts only toward `permanently_failed`.
 *
 * `oldest_pending_created_at` uses `created_at`, which a retry never moves,
 * so it reports true backlog age. `oldest_overdue_available_at` is scoped to
 * rows whose `available_at` is already due (`<= ?`), so a retry delayed into
 * the future does not count as overdue; a `processing` row's `available_at`
 * stays frozen at the time it became claimable, so a stuck lease still
 * surfaces as overdue.
 */
const D1_BACKLOG_QUERY: string = `
	SELECT 'delivery' AS queue,
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN 1 ELSE 0 END) AS pending_count,
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN created_at ELSE NULL END) AS oldest_pending_created_at,
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable = 1)) AND available_at <= ? THEN available_at ELSE NULL END) AS oldest_overdue_available_at,
		SUM(CASE WHEN status = 'failed' AND retryable = 0 THEN 1 ELSE 0 END) AS permanently_failed_count
	FROM delivery_outbox
	UNION ALL
	SELECT 'instance_invitation_delivery',
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN 1 ELSE 0 END),
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN created_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable = 1)) AND available_at <= ? THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND retryable = 0 THEN 1 ELSE 0 END)
	FROM instance_invitation_delivery_outbox
	UNION ALL
	SELECT 'completion_delivery',
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN 1 ELSE 0 END),
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN created_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable = 1)) AND available_at <= ? THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND retryable = 0 THEN 1 ELSE 0 END)
	FROM completion_delivery_outbox
	UNION ALL
	SELECT 'completion_artifact',
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN 1 ELSE 0 END),
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN created_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable = 1)) AND available_at <= ? THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND retryable = 0 THEN 1 ELSE 0 END)
	FROM completion_artifact_job
	UNION ALL
	SELECT 'completion_artifact_pdf_repair',
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN 1 ELSE 0 END),
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN created_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable = 1)) AND available_at <= ? THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND retryable = 0 THEN 1 ELSE 0 END)
	FROM completion_artifact_pdf_repair
	UNION ALL
	SELECT 'docx_conversion',
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN 1 ELSE 0 END),
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN created_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable = 1)) AND available_at <= ? THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND retryable = 0 THEN 1 ELSE 0 END)
	FROM docx_conversion_job
	UNION ALL
	SELECT 'pdf_seal',
		SUM(CASE WHEN status IN ('pending','processing','publication_ready') OR (status = 'failed' AND retryable = 1) THEN 1 ELSE 0 END),
		MIN(CASE WHEN status IN ('pending','processing','publication_ready') OR (status = 'failed' AND retryable = 1) THEN created_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing','publication_ready') OR (status = 'failed' AND retryable = 1)) AND available_at <= ? THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND retryable = 0 THEN 1 ELSE 0 END)
	FROM pdf_seal_job
	UNION ALL
	SELECT 'webhook_delivery',
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN 1 ELSE 0 END),
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable = 1) THEN event.occurred_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable = 1)) AND available_at <= ? THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND retryable = 0 THEN 1 ELSE 0 END)
	FROM webhook_outbox
	LEFT JOIN audit_event event ON event.id = webhook_outbox.audit_event_id
`;

export class D1MaintenanceBacklog implements MaintenanceBacklogPort {
	constructor(private readonly database: D1Database) {}

	async snapshot(now: Date): Promise<MaintenanceBacklogSnapshot> {
		const nowIso: string = now.toISOString();
		const result: D1Result<D1BacklogRow> = await this.database
			.prepare(D1_BACKLOG_QUERY)
			.bind(nowIso, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso)
			.all<D1BacklogRow>();
		return result.results.map((row: D1BacklogRow) => ({
			queue: row.queue,
			pendingCount: Number(row.pending_count),
			oldestPendingAgeSeconds: maintenanceBacklogAgeSeconds(
				now,
				row.queue,
				row.queue === 'webhook_delivery' ? 'occurred_at' : 'created_at',
				row.oldest_pending_created_at
			),
			oldestOverdueAgeSeconds: maintenanceBacklogAgeSeconds(
				now,
				row.queue,
				'available_at',
				row.oldest_overdue_available_at
			),
			permanentlyFailedCount: Number(row.permanently_failed_count)
		}));
	}
}
