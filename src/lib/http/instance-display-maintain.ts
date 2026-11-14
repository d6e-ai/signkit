import type { RequestHandler } from '@sveltejs/kit';
import type { InstanceDisplayMaintenanceService } from '$lib/application/instance-display/instance-display-maintenance-service';
import {
	INSTANCE_DISPLAY_CLEANUP_BATCH_LIMIT,
	INSTANCE_DISPLAY_RESEAL_BATCH_LIMIT
} from '$lib/domain/instance-display';
import {
	logMaintenanceOperationError,
	observeMaintenanceBatchResult
} from '$lib/observability/maintenance-telemetry';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import { resolveDeliveryWorkerSecret, type DeliveryWorkerSecretResolver } from './delivery-drain';
import { problemResponse } from './problem';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type InstanceDisplayMaintenanceServiceResolver = (
	context: ResolverContext
) => InstanceDisplayMaintenanceService | null | Promise<InstanceDisplayMaintenanceService | null>;

export function createInstanceDisplayMaintainHandler(
	resolveService: InstanceDisplayMaintenanceServiceResolver,
	resolveSecret: DeliveryWorkerSecretResolver = resolveDeliveryWorkerSecret
): RequestHandler {
	return async ({ platform, request, url }): Promise<Response> => {
		const presentedSecret: string | null = parseBearerSecret(request.headers.get('authorization'));
		if (presentedSecret === null) return unauthorized(url.pathname);

		const expectedSecret: string | null = resolveSecret(platform);
		if (expectedSecret === null) {
			return problemResponse({
				type: 'urn:signkit:problem:delivery-worker-unavailable',
				title: 'Delivery worker unavailable',
				status: 503,
				detail: 'The delivery worker is not configured.',
				instance: url.pathname
			});
		}
		if (!(await secretsEqual(presentedSecret, expectedSecret))) return unauthorized(url.pathname);

		let service: InstanceDisplayMaintenanceService | null;
		try {
			service = await resolveService({ platform });
		} catch (error: unknown) {
			logMaintenanceOperationError('instance_display_maintain_resolution_failed', error);
			service = null;
		}
		if (service === null) {
			return problemResponse({
				type: 'urn:signkit:problem:instance-display-unavailable',
				title: 'Instance display unavailable',
				status: 503,
				detail: 'The durable instance display store is not configured for this deployment.',
				instance: url.pathname
			});
		}

		const startedAt: number = Date.now();
		try {
			const result = await service.maintain(
				INSTANCE_DISPLAY_CLEANUP_BATCH_LIMIT,
				INSTANCE_DISPLAY_RESEAL_BATCH_LIMIT
			);
			return Response.json(result, {
				status: 200,
				headers: {
					'cache-control': 'no-store',
					...observeMaintenanceBatchResult(
						'instance display maintain',
						result,
						Date.now() - startedAt
					)
				}
			});
		} catch (error: unknown) {
			logMaintenanceOperationError('instance_display_maintain_failed', error);
			return problemResponse({
				type: 'urn:signkit:problem:instance-display-service-unavailable',
				title: 'Instance display service unavailable',
				status: 503,
				detail: 'The instance display maintenance batch could not be processed.',
				instance: url.pathname
			});
		}
	};
}

function unauthorized(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:delivery-worker-unauthorized',
		title: 'Unauthorized',
		status: 401,
		detail: 'A valid delivery worker credential is required.',
		instance
	});
}
