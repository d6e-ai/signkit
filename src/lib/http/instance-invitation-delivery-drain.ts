import type { RequestHandler } from '@sveltejs/kit';
import type { InstanceInvitationDeliveryService } from '$lib/application/instance-invitations/instance-invitation-delivery-service';
import {
	logMaintenanceOperationError,
	observeMaintenanceBatchResult
} from '$lib/observability/maintenance-telemetry';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import {
	resolveDeliveryWorkerSecret,
	type DeliveryWorkerSecretResolver
} from './delivery-worker-secret';
import { problemResponse } from './problem';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}
export type InstanceInvitationDeliveryServiceResolver = (
	context: ResolverContext
) => InstanceInvitationDeliveryService | null | Promise<InstanceInvitationDeliveryService | null>;

export function createInstanceInvitationDeliveryDrainHandler(
	resolveService: InstanceInvitationDeliveryServiceResolver,
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
		let service: InstanceInvitationDeliveryService | null;
		try {
			service = await resolveService({ platform });
		} catch {
			service = null;
		}
		if (service === null) {
			return problemResponse({
				type: 'urn:signkit:problem:instance-invitation-delivery-unavailable',
				title: 'Instance invitation delivery unavailable',
				status: 503,
				detail: 'The durable store, encryption key, and mail provider must be configured.',
				instance: url.pathname
			});
		}
		const startedAt: number = Date.now();
		try {
			const result = await service.deliverPending(25);
			return Response.json(result, {
				status: 200,
				headers: {
					'cache-control': 'no-store',
					...observeMaintenanceBatchResult(
						'instance invitation delivery drain',
						result,
						Date.now() - startedAt
					)
				}
			});
		} catch (error: unknown) {
			logMaintenanceOperationError('instance_invitation_delivery_drain_failed', error);
			return problemResponse({
				type: 'urn:signkit:problem:instance-invitation-delivery-failed',
				title: 'Instance invitation delivery failed',
				status: 503,
				detail: 'The delivery batch could not be processed.',
				instance: url.pathname
			});
		}
	};
}
