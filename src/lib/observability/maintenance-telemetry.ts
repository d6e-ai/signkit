/**
 * Portable maintenance batch telemetry shared by every drain/sweep HTTP
 * handler and the Cloudflare scheduled dispatcher that calls them. Every
 * drain/sweep handler returns its typed batch result as a flat JSON object
 * of counts plus an `outcomes`/`items` array; this module only ever reads
 * the known count fields and never the array, so IDs, error messages, and
 * other per-item detail are never logged.
 *
 * The handler itself is the primary telemetry boundary: it has the typed
 * result object directly, so it logs duration/counts once via
 * {@link observeMaintenanceBatchResult} and marks its response with
 * {@link MAINTENANCE_BATCH_OBSERVED_HEADER}. The scheduled dispatcher checks
 * that marker and, when present, does not re-decode the body at all — this
 * keeps batch telemetry a single, non-CF-specific concern instead of two
 * independent implementations that could double-log the same batch.
 */

export const MAINTENANCE_BATCH_COUNT_FIELDS = [
	'claimed',
	'delivered',
	'published',
	'succeeded',
	'seeded',
	'discovered',
	'expired',
	'skipped',
	'retried',
	'resealed',
	'stale',
	'scanned',
	'referenced',
	'inGracePeriod',
	'deleted',
	'failed',
	'retryableFailed',
	'permanentlyFailed',
	'integrityFailed',
	'unrecoverable'
] as const;

export type MaintenanceBatchCountField = (typeof MAINTENANCE_BATCH_COUNT_FIELDS)[number];

export type MaintenanceBatchSummary = Readonly<Partial<Record<MaintenanceBatchCountField, number>>>;

const FAILURE_SIGNAL_FIELDS: readonly MaintenanceBatchCountField[] = [
	'failed',
	'retryableFailed',
	'permanentlyFailed',
	'integrityFailed',
	'unrecoverable'
];

/** Set on every observed batch response so the scheduler never re-decodes (and double-logs) a body the handler already summarized. */
export const MAINTENANCE_BATCH_OBSERVED_HEADER: string = 'x-signkit-maintenance-batch-observed';

/**
 * Picks only known, non-negative safe-integer count fields. An invalid
 * known counter invalidates the whole summary; per-item arrays and unknown
 * fields are never logged. Observation distinguishes this from a healthy
 * all-zero batch instead of silently dropping a malformed failure count.
 */
export function summarizeMaintenanceBatchResult(value: unknown): MaintenanceBatchSummary {
	return validateMaintenanceBatchResult(value) ?? {};
}

function validateMaintenanceBatchResult(value: unknown): MaintenanceBatchSummary | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const source: Record<string, unknown> = value as Record<string, unknown>;
	const summary: Record<string, number> = {};
	for (const field of MAINTENANCE_BATCH_COUNT_FIELDS) {
		if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
		const candidate: unknown = source[field];
		if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
			return null;
		}
		summary[field] = candidate;
	}
	return Object.keys(summary).length === 0 ? null : summary;
}

export function maintenanceBatchHasFailureSignal(summary: MaintenanceBatchSummary): boolean {
	return FAILURE_SIGNAL_FIELDS.some((field: MaintenanceBatchCountField): boolean => {
		return (summary[field] ?? 0) > 0;
	});
}

/**
 * Called once by a drain/sweep handler right before it returns its batch
 * result, with the same object it is about to serialize. Logs at error
 * severity when any failure-like count is non-zero, otherwise at a
 * low-noise, non-alerting severity. Returns the header the handler must
 * merge into its response so the scheduler's fallback decode stays inert.
 */
export function observeMaintenanceBatchResult(
	job: string,
	result: unknown,
	durationMs: number
): HeadersInit {
	const summary: MaintenanceBatchSummary | null = validateMaintenanceBatchResult(result);
	if (summary === null) {
		logMaintenanceBatchSummaryUnavailable(job, durationMs, 'invalid');
	} else if (maintenanceBatchHasFailureSignal(summary)) {
		logMaintenanceBatchFailure(job, summary, durationMs);
	} else {
		logMaintenanceBatchCompleted(job, summary, durationMs);
	}
	return { [MAINTENANCE_BATCH_OBSERVED_HEADER]: '1' };
}

export type MaintenanceBatchBodyResult =
	| { ok: true; summary: MaintenanceBatchSummary }
	| { ok: false; reason: 'too_large' | 'invalid' | 'unavailable' };

/**
 * Fallback only: used by the scheduled dispatcher when a response lacks
 * {@link MAINTENANCE_BATCH_OBSERVED_HEADER}, i.e. it was not produced by a
 * handler already using {@link observeMaintenanceBatchResult}. Reads up to
 * `maxBytes`, cancelling the stream as soon as the limit is exceeded. Never
 * calls `response.text()`/`.json()`, which would buffer the whole body
 * regardless of size.
 */
export async function readMaintenanceBatchSummary(
	response: Response,
	maxBytes: number
): Promise<MaintenanceBatchBodyResult> {
	const contentLength: string | null = response.headers.get('content-length');
	if (contentLength !== null) {
		const declaredBytes: number = Number(contentLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
			return { ok: false, reason: 'too_large' };
		}
	}
	if (response.body === null) return { ok: false, reason: 'unavailable' };

	const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes: number = 0;
	try {
		for (;;) {
			const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (next.done) break;
			totalBytes += next.value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel('maintenance batch body exceeded the configured limit');
				return { ok: false, reason: 'too_large' };
			}
			chunks.push(next.value);
		}
	} catch {
		return { ok: false, reason: 'invalid' };
	} finally {
		reader.releaseLock();
	}

	const bytes: Uint8Array = new Uint8Array(totalBytes);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		const summary: MaintenanceBatchSummary | null = validateMaintenanceBatchResult(parsed);
		return summary === null ? { ok: false, reason: 'invalid' } : { ok: true, summary };
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}

/** Shared by every drain/sweep HTTP handler so failures are logged in one consistent shape. Never the raw error message. */
export function logMaintenanceOperationError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}

export function logMaintenanceBatchFailure(
	job: string,
	summary: MaintenanceBatchSummary,
	durationMs: number
): void {
	console.error(
		JSON.stringify({
			event: 'scheduled_maintenance_batch_failed',
			job,
			durationMs,
			...summary
		})
	);
}

/** Low-noise (non-error) success telemetry: one line per run, never escalated to an alerting channel. */
export function logMaintenanceBatchCompleted(
	job: string,
	summary: MaintenanceBatchSummary,
	durationMs: number
): void {
	console.log(
		JSON.stringify({
			event: 'scheduled_maintenance_batch_completed',
			job,
			durationMs,
			...summary
		})
	);
}

/**
 * The scheduler's fallback decode could not determine the batch outcome at
 * all (malformed, oversized, or missing body). This must never be a silent
 * no-op: a batch that cannot be observed is itself an operational signal.
 */
export function logMaintenanceBatchSummaryUnavailable(
	job: string,
	durationMs: number,
	reason: 'too_large' | 'invalid' | 'unavailable'
): void {
	console.warn(
		JSON.stringify({
			event: 'scheduled_maintenance_batch_summary_unavailable',
			job,
			durationMs,
			reason
		})
	);
}
