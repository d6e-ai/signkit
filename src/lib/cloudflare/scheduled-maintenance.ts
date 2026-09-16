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

/**
 * Every protected drain/sweep the Cloudflare cron must invoke. Each job is
 * scheduled independently so one failure cannot prevent the others from
 * starting. Order is documentation only; `waitUntil` runs them concurrently.
 */
export const SCHEDULED_MAINTENANCE_JOBS: readonly ScheduledMaintenanceJob[] = [
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
	},
	{ name: 'orphan sweep', path: '/api/v1/system/objects/orphan-sweep' }
];

export function runScheduledMaintenance(
	fetchHandler: ScheduledWorkerFetch,
	environment: ScheduledMaintenanceEnv,
	context: ScheduledMaintenanceContext
): void {
	for (const job of SCHEDULED_MAINTENANCE_JOBS) {
		context.waitUntil(
			runScheduledJob(fetchHandler, environment, context, job).catch((error: unknown): void => {
				logScheduledMaintenanceFailure(job, error);
			})
		);
	}
}

async function runScheduledJob(
	fetchHandler: ScheduledWorkerFetch,
	environment: ScheduledMaintenanceEnv,
	context: ScheduledMaintenanceContext,
	job: ScheduledMaintenanceJob
): Promise<void> {
	if (typeof environment.DELIVERY_WORKER_SECRET !== 'string') {
		throw new Error('Delivery worker secret is unavailable');
	}
	const response: Response = await fetchHandler(
		new Request(`${INTERNAL_ORIGIN}${job.path}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${environment.DELIVERY_WORKER_SECRET}` }
		}),
		environment,
		context
	);
	if (!response.ok) throw new Error(`${job.name} failed with status ${response.status}`);
}

function logScheduledMaintenanceFailure(job: ScheduledMaintenanceJob, error: unknown): void {
	console.error(
		JSON.stringify({
			event: 'scheduled_maintenance_failed',
			job: job.name,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
