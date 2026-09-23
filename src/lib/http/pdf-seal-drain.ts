import type { RequestHandler } from '@sveltejs/kit';
import type { PdfSealRuntime } from '$lib/application/pdf-seals/pdf-seal-runtime';
import type { PdfSealDrainResult } from '$lib/application/pdf-seals/pdf-seal-drain-service';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import { resolveDeliveryWorkerSecret, type DeliveryWorkerSecretResolver } from './delivery-drain';
import { problemResponse } from './problem';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type PdfSealRuntimeResolver = (
	context: ResolverContext
) => PdfSealRuntime | null | Promise<PdfSealRuntime | null>;

export function createPdfSealDrainHandler(
	resolveRuntime: PdfSealRuntimeResolver,
	resolveSecret: DeliveryWorkerSecretResolver = resolveDeliveryWorkerSecret
): RequestHandler {
	return async ({ platform, request, url }): Promise<Response> => {
		const presentedSecret: string | null = parseBearerSecret(request.headers.get('authorization'));
		if (presentedSecret === null) return unauthorized(url.pathname);
		const expectedSecret: string | null = resolveSecret(platform);
		if (expectedSecret === null) return unavailable(url.pathname);
		if (!(await secretsEqual(presentedSecret, expectedSecret))) return unauthorized(url.pathname);

		let runtime: PdfSealRuntime | null;
		try {
			runtime = await resolveRuntime({ platform });
		} catch (error: unknown) {
			logPdfSealError('pdf_seal_runtime_resolution_failed', error);
			return unavailable(url.pathname);
		}
		if (runtime === null) return unavailable(url.pathname);

		try {
			const result: PdfSealDrainResult = await runtime.drainService.drain();
			return Response.json(result, {
				status: 200,
				headers: { 'cache-control': 'no-store' }
			});
		} catch (error: unknown) {
			logPdfSealError('pdf_seal_drain_failed', error);
			return problemResponse({
				type: 'urn:signkit:problem:pdf-seal-service-unavailable',
				title: 'PDF seal service unavailable',
				status: 503,
				detail: 'The PDF seal batch could not be processed.',
				instance: url.pathname
			});
		}
	};
}

function unauthorized(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:maintenance-unauthorized',
		title: 'Unauthorized',
		status: 401,
		detail: 'A valid maintenance credential is required.',
		instance
	});
}

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:pdf-seal-unavailable',
		title: 'PDF sealing unavailable',
		status: 503,
		detail: 'PDF sealing is disabled or its durable dependencies are unavailable.',
		instance
	});
}

function logPdfSealError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
