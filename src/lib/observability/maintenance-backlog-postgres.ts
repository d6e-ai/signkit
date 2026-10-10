import postgres from 'postgres';
import {
	maintenanceBacklogAgeSeconds,
	type MaintenanceBacklogPort,
	type MaintenanceBacklogQueue,
	type MaintenanceBacklogSnapshot
} from './maintenance-backlog';

interface PostgresBacklogRow {
	queue: MaintenanceBacklogQueue;
	pending_count: number;
	oldest_pending_created_at: Date | string | null;
	oldest_overdue_available_at: Date | string | null;
	permanently_failed_count: number;
}

/**
 * Mirrors {@link import('./maintenance-backlog-d1').D1MaintenanceBacklog} for
 * the PostgreSQL self-hosted runtime; see that file for the shared pending
 * vs. overdue age semantics. Table and column names are fixed identifiers
 * from this file, never built from request input.
 */
const POSTGRES_BACKLOG_QUERY: string = `
	SELECT 'delivery' AS queue,
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN 1 ELSE 0 END)::int AS pending_count,
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN created_at ELSE NULL END) AS oldest_pending_created_at,
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable)) AND available_at <= $1 THEN available_at ELSE NULL END) AS oldest_overdue_available_at,
		SUM(CASE WHEN status = 'failed' AND NOT retryable THEN 1 ELSE 0 END)::int AS permanently_failed_count
	FROM delivery_outbox
	UNION ALL
	SELECT 'instance_invitation_delivery',
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN 1 ELSE 0 END)::int,
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN created_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable)) AND available_at <= $1 THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND NOT retryable THEN 1 ELSE 0 END)::int
	FROM instance_invitation_delivery_outbox
	UNION ALL
	SELECT 'completion_delivery',
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN 1 ELSE 0 END)::int,
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN created_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable)) AND available_at <= $1 THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND NOT retryable THEN 1 ELSE 0 END)::int
	FROM completion_delivery_outbox
	UNION ALL
	SELECT 'completion_artifact',
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN 1 ELSE 0 END)::int,
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN created_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable)) AND available_at <= $1 THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND NOT retryable THEN 1 ELSE 0 END)::int
	FROM completion_artifact_job
	UNION ALL
	SELECT 'docx_conversion',
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN 1 ELSE 0 END)::int,
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN created_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable)) AND available_at <= $1 THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND NOT retryable THEN 1 ELSE 0 END)::int
	FROM docx_conversion_job
	UNION ALL
	SELECT 'pdf_seal',
		SUM(CASE WHEN status IN ('pending','processing','publication_ready') OR (status = 'failed' AND retryable) THEN 1 ELSE 0 END)::int,
		MIN(CASE WHEN status IN ('pending','processing','publication_ready') OR (status = 'failed' AND retryable) THEN created_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing','publication_ready') OR (status = 'failed' AND retryable)) AND available_at <= $1 THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND NOT retryable THEN 1 ELSE 0 END)::int
	FROM pdf_seal_job
	UNION ALL
	SELECT 'webhook_delivery',
		SUM(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN 1 ELSE 0 END)::int,
		MIN(CASE WHEN status IN ('pending','processing') OR (status = 'failed' AND retryable) THEN event.occurred_at ELSE NULL END),
		MIN(CASE WHEN (status IN ('pending','processing') OR (status = 'failed' AND retryable)) AND available_at <= $1 THEN available_at ELSE NULL END),
		SUM(CASE WHEN status = 'failed' AND NOT retryable THEN 1 ELSE 0 END)::int
	FROM webhook_outbox
	LEFT JOIN audit_event event ON event.id = webhook_outbox.audit_event_id
`;

export class PostgresMaintenanceBacklog implements MaintenanceBacklogPort {
	constructor(private readonly sql: ReturnType<typeof postgres>) {}

	async snapshot(now: Date): Promise<MaintenanceBacklogSnapshot> {
		const rows: PostgresBacklogRow[] = await this.sql.unsafe<PostgresBacklogRow[]>(
			POSTGRES_BACKLOG_QUERY,
			[now.toISOString()]
		);
		return rows.map((row: PostgresBacklogRow) => ({
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
