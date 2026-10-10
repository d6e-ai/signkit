/**
 * Durable maintenance queue backlog shape, shared by the D1 and PostgreSQL
 * read-only adapters and the protected health endpoint. Exposes only
 * aggregate counts and ages: never a row id, payload, or error message.
 */
export const MAINTENANCE_BACKLOG_QUEUES = [
	'delivery',
	'instance_invitation_delivery',
	'completion_delivery',
	'completion_artifact',
	'docx_conversion',
	'pdf_seal',
	'webhook_delivery'
] as const;

export type MaintenanceBacklogQueue = (typeof MAINTENANCE_BACKLOG_QUEUES)[number];

export interface MaintenanceBacklogQueueSnapshot {
	readonly queue: MaintenanceBacklogQueue;
	/**
	 * Rows not yet terminal: pending, currently claimed (`processing`), or
	 * failed-but-retryable — including a retry delayed into the future. A
	 * delayed retry still counts here even though it is not yet due.
	 */
	readonly pendingCount: number;
	/**
	 * True lifetime age (since `created_at`) of the oldest pending row, or
	 * `null` when `pendingCount` is 0. Unlike `available_at`, `created_at`
	 * never moves when a retry is scheduled, so a row stuck retrying for
	 * hours cannot look freshly created here.
	 */
	readonly oldestPendingAgeSeconds: number | null;
	/**
	 * Age (since `available_at`) of the oldest pending row that is actually
	 * due right now (`available_at <= now`), or `null` when nothing is due —
	 * including when every pending row is a retry delayed into the future.
	 * A `processing` row's `available_at` is frozen at the time it became
	 * claimable, so a lease stuck past its retry window also surfaces here.
	 */
	readonly oldestOverdueAgeSeconds: number | null;
	readonly permanentlyFailedCount: number;
}

export type MaintenanceBacklogSnapshot = readonly MaintenanceBacklogQueueSnapshot[];

export interface MaintenanceBacklogPort {
	snapshot(now: Date): Promise<MaintenanceBacklogSnapshot>;
}

/**
 * A non-null timestamp that fails to parse is a data integrity problem, not
 * an empty queue, and must never be reported as a healthy `null` age.
 */
export class MaintenanceBacklogCorruptionError extends Error {
	constructor(queue: string, field: string) {
		super(`${queue}.${field} is not a valid timestamp`);
		this.name = 'MaintenanceBacklogCorruptionError';
	}
}

export function maintenanceBacklogAgeSeconds(
	now: Date,
	queue: string,
	field: string,
	value: string | Date | null
): number | null {
	if (value === null) return null;
	const parsed: number = new Date(value).valueOf();
	if (!Number.isFinite(parsed)) throw new MaintenanceBacklogCorruptionError(queue, field);
	return Math.max(0, Math.round((now.valueOf() - parsed) / 1000));
}
