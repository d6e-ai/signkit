import { hasHandledMaintenanceFailure } from '$lib/observability/maintenance-failure';

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
	if (typeof environment.DELIVERY_WORKER_SECRET !== 'string') {
		throw new ScheduledMaintenanceFailure('maintenance_secret_unavailable');
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
		throw new ScheduledMaintenanceFailure('maintenance_dispatch_failed', undefined, error);
	}
	if (!response.ok && !hasHandledMaintenanceFailure(response)) {
		throw new ScheduledMaintenanceFailure('maintenance_http_failed', response.status);
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
			...(failure.status === undefined ? {} : { status: failure.status })
		})
	);
}

class ScheduledMaintenanceFailure extends Error {
	readonly code: string;
	readonly status: number | undefined;

	constructor(code: string, status?: number, cause?: unknown) {
		super(code, { cause });
		this.name = 'ScheduledMaintenanceFailure';
		this.code = code;
		this.status = status;
	}
}
