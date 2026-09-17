import type { RequestHandler } from '@sveltejs/kit';
import type {
	DocxConversionBatchResult,
	DocxConversionService
} from '$lib/application/documents/docx-conversion-service';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import { resolveDeliveryWorkerSecret, type DeliveryWorkerSecretResolver } from './delivery-drain';
import { problemResponse } from './problem';

const DRAIN_BATCH_LIMIT: number = 10;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type DocxConversionServiceResolver = (
	context: ResolverContext
) => DocxConversionService | null | Promise<DocxConversionService | null>;

export function createDocxConversionDrainHandler(
	resolveService: DocxConversionServiceResolver,
	resolveSecret: DeliveryWorkerSecretResolver = resolveDeliveryWorkerSecret
): RequestHandler {
	return async ({ platform, request, url }): Promise<Response> => {
		const presentedSecret: string | null = parseBearerSecret(request.headers.get('authorization'));
		if (presentedSecret === null) return unauthorized(url.pathname);
		const expectedSecret: string | null = resolveSecret(platform);
		if (expectedSecret === null) return unavailable(url.pathname);
		if (!(await secretsEqual(presentedSecret, expectedSecret))) return unauthorized(url.pathname);

		let service: DocxConversionService | null;
		try {
			service = await resolveService({ platform });
		} catch (error: unknown) {
			logFailure('docx_conversion_drain_resolution_failed', error);
			return unavailable(url.pathname);
		}
		if (service === null) return unavailable(url.pathname);

		try {
			const result: DocxConversionBatchResult = await service.processPendingBatch({
				limit: DRAIN_BATCH_LIMIT
			});
			return Response.json(result, { headers: { 'cache-control': 'no-store' } });
		} catch (error: unknown) {
			logFailure('docx_conversion_drain_failed', error);
			return unavailable(url.pathname);
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

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:docx-conversion-unavailable',
		title: 'DOCX conversion unavailable',
		status: 503,
		detail: 'The DOCX conversion worker is not configured or could not process the batch.',
		instance
	});
}

function logFailure(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
