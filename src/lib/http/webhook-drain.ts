import type { RequestHandler } from '@sveltejs/kit';
import type {
	WebhookApplicationPort,
	WebhookDeliveryBatchResult
} from '$lib/application/webhooks/webhook-service';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import {
	resolveDeliveryWorkerSecret,
	type DeliveryWorkerSecretResolver
} from './delivery-worker-secret';
import { problemResponse } from './problem';

const DRAIN_BATCH_LIMIT: number = 25;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type WebhookApplicationResolver = (
	context: ResolverContext
) => WebhookApplicationPort | null | Promise<WebhookApplicationPort | null>;

export function createWebhookDrainHandler(
	resolveApplication: WebhookApplicationResolver,
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

		let application: WebhookApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'webhook_drain_resolution_failed',
					message: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			application = null;
		}
		if (application === null) {
			return problemResponse({
				type: 'urn:signkit:problem:webhook-unavailable',
				title: 'Webhook delivery unavailable',
				status: 503,
				detail: 'The webhook store must be configured.',
				instance: url.pathname
			});
		}

		try {
			const result: WebhookDeliveryBatchResult =
				await application.drainPendingDeliveries(DRAIN_BATCH_LIMIT);
			return Response.json(result, {
				status: 200,
				headers: { 'cache-control': 'no-store' }
			});
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'webhook_drain_failed',
					message: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return problemResponse({
				type: 'urn:signkit:problem:webhook-service-unavailable',
				title: 'Webhook service unavailable',
				status: 503,
				detail: 'The webhook batch could not be processed.',
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
