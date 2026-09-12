import type { RequestHandler } from '@sveltejs/kit';
import type {
	CompletionDeliveryBatchResult,
	CompletionDeliveryService
} from '$lib/application/completion-delivery/completion-delivery-service';
import { resolveDeliveryWorkerSecret, type DeliveryWorkerSecretResolver } from './delivery-drain';
import { problemResponse } from './problem';

const DRAIN_BATCH_LIMIT: number = 25;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type CompletionDeliveryServiceResolver = (
	context: ResolverContext
) => CompletionDeliveryService | null | Promise<CompletionDeliveryService | null>;

export function createCompletionDeliveryDrainHandler(
	resolveService: CompletionDeliveryServiceResolver,
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

		let service: CompletionDeliveryService | null;
		try {
			service = await resolveService({ platform });
		} catch (error: unknown) {
			logCompletionDeliveryError('completion_delivery_drain_resolution_failed', error);
			service = null;
		}
		if (service === null) {
			return problemResponse({
				type: 'urn:signkit:problem:completion-delivery-unavailable',
				title: 'Completion delivery unavailable',
				status: 503,
				detail:
					'The completion delivery store, encryption key, and mail provider must be configured.',
				instance: url.pathname
			});
		}

		try {
			const result: CompletionDeliveryBatchResult =
				await service.deliverPendingCompletions(DRAIN_BATCH_LIMIT);
			return Response.json(result, {
				status: 200,
				headers: { 'cache-control': 'no-store' }
			});
		} catch (error: unknown) {
			logCompletionDeliveryError('completion_delivery_drain_failed', error);
			return problemResponse({
				type: 'urn:signkit:problem:completion-delivery-service-unavailable',
				title: 'Completion delivery service unavailable',
				status: 503,
				detail: 'The completion delivery batch could not be processed.',
				instance: url.pathname
			});
		}
	};
}

function parseBearerSecret(header: string | null): string | null {
	if (header === null) return null;
	const match: RegExpExecArray | null = /^Bearer ([\x21-\x7e]{32,200})$/.exec(header);
	return match?.[1] ?? null;
}

async function secretsEqual(presented: string, expected: string): Promise<boolean> {
	const [presentedDigest, expectedDigest]: [ArrayBuffer, ArrayBuffer] = await Promise.all([
		sha256(presented),
		sha256(expected)
	]);
	const left: Uint8Array = new Uint8Array(presentedDigest);
	const right: Uint8Array = new Uint8Array(expectedDigest);
	let difference: number = left.byteLength ^ right.byteLength;
	const length: number = Math.max(left.byteLength, right.byteLength);
	for (let index: number = 0; index < length; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

function sha256(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
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

function logCompletionDeliveryError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
