import type { RequestHandler } from '@sveltejs/kit';
import type { MaintenanceBacklogPort } from '$lib/observability/maintenance-backlog';
import { logMaintenanceOperationError } from '$lib/observability/maintenance-telemetry';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import {
	resolveDeliveryWorkerSecret,
	type DeliveryWorkerSecretResolver
} from './delivery-worker-secret';
import { problemResponse } from './problem';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type MaintenanceBacklogPortResolver = (
	context: ResolverContext
) => MaintenanceBacklogPort | null | Promise<MaintenanceBacklogPort | null>;

/**
 * Read-only self-hosting health probe: oldest pending/overdue age and
 * permanently failed counts per durable queue, nothing else. Reuses the
 * same delivery worker secret as every drain route rather than a separate
 * credential.
 */
export function createMaintenanceHealthHandler(
	resolvePort: MaintenanceBacklogPortResolver,
	resolveSecret: DeliveryWorkerSecretResolver = resolveDeliveryWorkerSecret
): RequestHandler {
	return async ({ platform, request, url }): Promise<Response> => {
		const presented: string | null = parseBearerSecret(request.headers.get('authorization'));
		const expected: string | null = resolveSecret(platform);
		if (presented === null || expected === null || !(await secretsEqual(presented, expected))) {
			return problemResponse({
				type: 'urn:signkit:problem:delivery-worker-unauthorized',
				title: 'Unauthorized',
				status: 401,
				detail: 'A valid delivery worker credential is required.',
				instance: url.pathname
			});
		}

		let port: MaintenanceBacklogPort | null;
		try {
			port = await resolvePort({ platform });
		} catch (error: unknown) {
			logMaintenanceOperationError('maintenance_health_resolution_failed', error);
			port = null;
		}
		if (port === null) {
			return problemResponse({
				type: 'urn:signkit:problem:maintenance-health-unavailable',
				title: 'Maintenance health unavailable',
				status: 503,
				detail: 'The durable maintenance store is not configured.',
				instance: url.pathname
			});
		}

		try {
			const queues = await port.snapshot(new Date());
			return Response.json({ queues }, { status: 200, headers: { 'cache-control': 'no-store' } });
		} catch (error: unknown) {
			logMaintenanceOperationError('maintenance_health_query_failed', error);
			return problemResponse({
				type: 'urn:signkit:problem:maintenance-health-failed',
				title: 'Maintenance health query failed',
				status: 503,
				detail: 'The backlog snapshot could not be read.',
				instance: url.pathname
			});
		}
	};
}
