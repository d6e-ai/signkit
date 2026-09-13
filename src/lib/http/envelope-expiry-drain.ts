import type { RequestHandler } from '@sveltejs/kit';
import type {
	EnvelopeExpiryBatchResult,
	EnvelopeExpiryDrainService
} from '$lib/application/delivery/envelope-expiry-service';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import { resolveDeliveryWorkerSecret, type DeliveryWorkerSecretResolver } from './delivery-drain';
import { problemResponse } from './problem';

const DRAIN_BATCH_LIMIT: number = 25;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type EnvelopeExpiryDrainServiceResolver = (
	context: ResolverContext
) => EnvelopeExpiryDrainService | null | Promise<EnvelopeExpiryDrainService | null>;

/**
 * Makes the `expired` envelope terminal state actually reachable. Reuses the
 * `DELIVERY_WORKER_SECRET` constant-time bearer convention rather than a new
 * credential, matching every other internal drain.
 */
export function createEnvelopeExpiryDrainHandler(
	resolveService: EnvelopeExpiryDrainServiceResolver,
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

		let service: EnvelopeExpiryDrainService | null;
		try {
			service = await resolveService({ platform });
		} catch (error: unknown) {
			logExpiryDrainError('envelope_expiry_drain_resolution_failed', error);
			service = null;
		}
		if (service === null) {
			return problemResponse({
				type: 'urn:signkit:problem:envelope-expiry-unavailable',
				title: 'Envelope expiry drain unavailable',
				status: 503,
				detail: 'The envelope expiry store must be configured.',
				instance: url.pathname
			});
		}

		try {
			const result: EnvelopeExpiryBatchResult =
				await service.drainExpiredEnvelopes(DRAIN_BATCH_LIMIT);
			return Response.json(result, {
				status: 200,
				headers: { 'cache-control': 'no-store' }
			});
		} catch (error: unknown) {
			logExpiryDrainError('envelope_expiry_drain_failed', error);
			return problemResponse({
				type: 'urn:signkit:problem:envelope-expiry-service-unavailable',
				title: 'Envelope expiry service unavailable',
				status: 503,
				detail: 'The envelope expiry batch could not be processed.',
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

function logExpiryDrainError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
