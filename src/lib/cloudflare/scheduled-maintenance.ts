import { hasHandledMaintenanceFailure } from '$lib/observability/maintenance-failure';
import {
	logMaintenanceBatchFailure,
	logMaintenanceBatchSummaryUnavailable,
	MAINTENANCE_BATCH_OBSERVED_HEADER,
	maintenanceBatchHasFailureSignal,
	readMaintenanceBatchSummary,
	type MaintenanceBatchBodyResult
} from '$lib/observability/maintenance-telemetry';

/**
 * A batch result is a flat object of bounded counts (at most a few dozen
 * bytes per field); this generously bounds the decode without ever
 * buffering an unbounded body.
 */
const MAX_MAINTENANCE_BATCH_BYTES: number = 64 * 1024;

export interface ScheduledMaintenanceJob {
	readonly name: string;
	readonly path: string;
}

export interface ScheduledMaintenanceEnv {
	readonly DELIVERY_WORKER_SECRET?: unknown;
}

export interface ScheduledMaintenanceContext {
	waitUntil(promise: Promise<unknown>): void;
}

export type ScheduledWorkerFetch = (
	request: Request,
	environment: unknown,
	context: unknown
) => Promise<Response>;

const INTERNAL_ORIGIN: string = 'https://signkit.internal';
export const PRIMARY_MAINTENANCE_CRON: string = '* * * * *';
export const ORPHAN_SWEEP_CRON: string = '*/5 * * * *';

/**
 * Every protected drain/sweep the Cloudflare cron must invoke. Each job is
 * scheduled independently so one failure cannot prevent the others from
 * starting. Order is documentation only; `waitUntil` runs them concurrently.
 */
export const PRIMARY_MAINTENANCE_JOBS: readonly ScheduledMaintenanceJob[] = [
	{ name: 'instance invitation delivery drain', path: '/api/v1/system/instance-invitations/drain' },
	{ name: 'delivery drain', path: '/api/v1/system/deliveries/drain' },
	{ name: 'DOCX conversion drain', path: '/api/v1/system/docx-conversions/drain' },
	{ name: 'completion artifact drain', path: '/api/v1/system/completion-artifacts/drain' },
	{ name: 'PDF seal drain', path: '/api/v1/system/pdf-seals/drain' },
	{ name: 'completion delivery drain', path: '/api/v1/system/completion-deliveries/drain' },
	{ name: 'envelope expiry drain', path: '/api/v1/system/envelopes/expiry-drain' },
	{ name: 'webhook drain', path: '/api/v1/system/webhooks/drain' },
	{ name: 'delivery reseal sweep', path: '/api/v1/system/deliveries/reseal-sweep' },
	{
		name: 'completion delivery reseal sweep',
		path: '/api/v1/system/completion-deliveries/reseal-sweep'
	}
];

export const ORPHAN_SWEEP_JOBS: readonly ScheduledMaintenanceJob[] = [
	{ name: 'orphan sweep', path: '/api/v1/system/objects/orphan-sweep' }
];

export const SCHEDULED_MAINTENANCE_JOBS: readonly ScheduledMaintenanceJob[] = [
	...PRIMARY_MAINTENANCE_JOBS,
	...ORPHAN_SWEEP_JOBS
];

export function runScheduledMaintenance(
	fetchHandler: ScheduledWorkerFetch,
	environment: ScheduledMaintenanceEnv,
	context: ScheduledMaintenanceContext,
	cron?: string
): void {
	const jobs: readonly ScheduledMaintenanceJob[] | undefined = scheduledJobsForCron(cron);
	if (jobs === undefined) {
		console.error(
			JSON.stringify({
				event: 'scheduled_maintenance_unknown_cron',
				code: 'maintenance_schedule_unrecognized'
			})
		);
		return;
	}
	for (const job of jobs) {
		context.waitUntil(
			runScheduledJob(fetchHandler, environment, context, job).catch((error: unknown): void => {
				logScheduledMaintenanceFailure(job, error);
			})
		);
	}
}

function scheduledJobsForCron(
	cron: string | undefined
): readonly ScheduledMaintenanceJob[] | undefined {
	// Keeping orphan collection in a separate invocation gives its bounded D1
	// reference checks an independent per-invocation query budget.
	if (cron === undefined) return SCHEDULED_MAINTENANCE_JOBS;
	if (cron === PRIMARY_MAINTENANCE_CRON) return PRIMARY_MAINTENANCE_JOBS;
	if (cron === ORPHAN_SWEEP_CRON) return ORPHAN_SWEEP_JOBS;
	return undefined;
}

async function runScheduledJob(
	fetchHandler: ScheduledWorkerFetch,
	environment: ScheduledMaintenanceEnv,
	context: ScheduledMaintenanceContext,
	job: ScheduledMaintenanceJob
): Promise<void> {
	const startedAt: number = Date.now();
	if (typeof environment.DELIVERY_WORKER_SECRET !== 'string') {
		throw new ScheduledMaintenanceFailure(
			'maintenance_secret_unavailable',
			undefined,
			undefined,
			Date.now() - startedAt
		);
	}
	let response: Response;
	try {
		response = await fetchHandler(
			new Request(`${INTERNAL_ORIGIN}${job.path}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${environment.DELIVERY_WORKER_SECRET}` }
			}),
			environment,
			context
		);
	} catch (error: unknown) {
		throw new ScheduledMaintenanceFailure(
			'maintenance_dispatch_failed',
			undefined,
			error,
			Date.now() - startedAt
		);
	}
	if (!response.ok) {
		if (hasHandledMaintenanceFailure(response)) return;
		throw new ScheduledMaintenanceFailure(
			'maintenance_http_failed',
			response.status,
			undefined,
			Date.now() - startedAt
		);
	}

	// Every handler this dispatcher calls already logs its own batch outcome
	// via `observeMaintenanceBatchResult` and marks its response. Decoding the
	// body here too would risk logging the same batch twice, so this is a
	// fallback only for a response that was not already observed.
	if (response.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER) !== null) return;

	const durationMs: number = Date.now() - startedAt;
	const body: MaintenanceBatchBodyResult = await readMaintenanceBatchSummary(
		response,
		MAX_MAINTENANCE_BATCH_BYTES
	);
	if (!body.ok) {
		// A batch result that cannot even be read is itself an operational
		// signal, not a healthy no-op.
		logMaintenanceBatchSummaryUnavailable(job.name, durationMs, body.reason);
		return;
	}
	if (maintenanceBatchHasFailureSignal(body.summary)) {
		logMaintenanceBatchFailure(job.name, body.summary, durationMs);
	}
}

function logScheduledMaintenanceFailure(job: ScheduledMaintenanceJob, error: unknown): void {
	const failure: ScheduledMaintenanceFailure =
		error instanceof ScheduledMaintenanceFailure
			? error
			: new ScheduledMaintenanceFailure('maintenance_unexpected_failure', undefined, error);
	console.error(
		JSON.stringify({
			event: 'scheduled_maintenance_failed',
			job: job.name,
			code: failure.code,
			...(failure.status === undefined ? {} : { status: failure.status }),
			...(failure.durationMs === undefined ? {} : { durationMs: failure.durationMs })
		})
	);
}

class ScheduledMaintenanceFailure extends Error {
	readonly code: string;
	readonly status: number | undefined;
	readonly durationMs: number | undefined;

	constructor(code: string, status?: number, cause?: unknown, durationMs?: number) {
		super(code, { cause });
		this.name = 'ScheduledMaintenanceFailure';
		this.code = code;
		this.status = status;
		this.durationMs = durationMs;
	}
}
