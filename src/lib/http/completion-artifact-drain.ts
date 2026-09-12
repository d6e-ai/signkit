import type { RequestHandler } from '@sveltejs/kit';
import type {
	CompletionArtifactBatchResult,
	CompletionArtifactPublicationService
} from '$lib/application/completion-artifacts/completion-artifact-service';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import { resolveDeliveryWorkerSecret, type DeliveryWorkerSecretResolver } from './delivery-drain';
import { problemResponse } from './problem';

const DRAIN_BATCH_LIMIT: number = 10;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type CompletionArtifactServiceResolver = (
	context: ResolverContext
) =>
	| CompletionArtifactPublicationService
	| null
	| Promise<CompletionArtifactPublicationService | null>;

/**
 * Reuses the DELIVERY_WORKER_SECRET constant-time bearer convention: this is
 * an internal reconciliation drain, not a second worker credential.
 */
export function createCompletionArtifactDrainHandler(
	resolveService: CompletionArtifactServiceResolver,
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

		let service: CompletionArtifactPublicationService | null;
		try {
			service = await resolveService({ platform });
		} catch (error: unknown) {
			logCompletionArtifactError('completion_artifact_drain_resolution_failed', error);
			service = null;
		}
		if (service === null) {
			return problemResponse({
				type: 'urn:signkit:problem:completion-artifact-unavailable',
				title: 'Completion artifact publication unavailable',
				status: 503,
				detail: 'The completion artifact store and object storage must be configured.',
				instance: url.pathname
			});
		}

		try {
			const result: CompletionArtifactBatchResult =
				await service.publishPendingCompletionArtifacts(DRAIN_BATCH_LIMIT);
			return Response.json(result, {
				status: 200,
				headers: { 'cache-control': 'no-store' }
			});
		} catch (error: unknown) {
			logCompletionArtifactError('completion_artifact_drain_failed', error);
			return problemResponse({
				type: 'urn:signkit:problem:completion-artifact-service-unavailable',
				title: 'Completion artifact service unavailable',
				status: 503,
				detail: 'The completion artifact batch could not be processed.',
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

function logCompletionArtifactError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
