import type { RequestHandler } from '@sveltejs/kit';
import type {
	CompletionDeliveryResealSweepResult,
	CompletionDeliveryResealSweepService
} from '$lib/application/completion-delivery/completion-reseal-sweep-service';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import { resolveDeliveryWorkerSecret, type DeliveryWorkerSecretResolver } from './delivery-drain';
import { problemResponse } from './problem';

const RESEAL_SWEEP_BATCH_LIMIT: number = 50;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type CompletionDeliveryResealSweepServiceResolver = (
	context: ResolverContext
) =>
	| CompletionDeliveryResealSweepService
	| null
	| Promise<CompletionDeliveryResealSweepService | null>;

/**
 * Maintenance endpoint, not part of the hot delivery path: migrates
 * outstanding (non-`processing`) completion delivery outbox ciphertext off
 * a retiring key onto the active one. Reuses the `DELIVERY_WORKER_SECRET`
 * constant-time bearer convention rather than a new credential.
 */
export function createCompletionDeliveryResealSweepHandler(
	resolveService: CompletionDeliveryResealSweepServiceResolver,
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

		let service: CompletionDeliveryResealSweepService | null;
		try {
			service = await resolveService({ platform });
		} catch (error: unknown) {
			logResealSweepError('completion_delivery_reseal_sweep_resolution_failed', error);
			service = null;
		}
		if (service === null) {
			return problemResponse({
				type: 'urn:signkit:problem:completion-delivery-unavailable',
				title: 'Completion delivery unavailable',
				status: 503,
				detail: 'The completion delivery store and encryption key must be configured.',
				instance: url.pathname
			});
		}

		try {
			const result: CompletionDeliveryResealSweepResult =
				await service.resealOutstandingTokens(RESEAL_SWEEP_BATCH_LIMIT);
			return Response.json(result, {
				status: 200,
				headers: { 'cache-control': 'no-store' }
			});
		} catch (error: unknown) {
			logResealSweepError('completion_delivery_reseal_sweep_failed', error);
			return problemResponse({
				type: 'urn:signkit:problem:completion-delivery-service-unavailable',
				title: 'Completion delivery service unavailable',
				status: 503,
				detail: 'The reseal sweep batch could not be processed.',
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

function logResealSweepError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
