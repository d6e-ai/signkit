import type { RequestHandler } from '@sveltejs/kit';
import type {
	InvitationDeliveryBatchResult,
	InvitationDeliveryService
} from '$lib/application/delivery/delivery-service';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import {
	resolveDeliveryWorkerSecret,
	type DeliveryWorkerSecretResolver
} from './delivery-worker-secret';
import { problemResponse } from './problem';

export {
	resolveDeliveryWorkerSecret,
	type DeliveryWorkerSecretResolver
} from './delivery-worker-secret';

const DRAIN_BATCH_LIMIT: number = 25;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type InvitationDeliveryServiceResolver = (
	context: ResolverContext
) => InvitationDeliveryService | null | Promise<InvitationDeliveryService | null>;

export function createDeliveryDrainHandler(
	resolveService: InvitationDeliveryServiceResolver,
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

		let service: InvitationDeliveryService | null;
		try {
			service = await resolveService({ platform });
		} catch (error: unknown) {
			logDeliveryError('delivery_drain_resolution_failed', error);
			service = null;
		}
		if (service === null) {
			return problemResponse({
				type: 'urn:signkit:problem:delivery-unavailable',
				title: 'Delivery unavailable',
				status: 503,
				detail: 'The delivery store, encryption key, and mail provider must be configured.',
				instance: url.pathname
			});
		}

		try {
			const result: InvitationDeliveryBatchResult =
				await service.deliverPendingInvitations(DRAIN_BATCH_LIMIT);
			return Response.json(result, {
				status: 200,
				headers: { 'cache-control': 'no-store' }
			});
		} catch (error: unknown) {
			logDeliveryError('delivery_drain_failed', error);
			return problemResponse({
				type: 'urn:signkit:problem:delivery-service-unavailable',
				title: 'Delivery service unavailable',
				status: 503,
				detail: 'The delivery batch could not be processed.',
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

function logDeliveryError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
