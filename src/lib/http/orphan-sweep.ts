import type { RequestHandler } from '@sveltejs/kit';
import {
	DEFAULT_ORPHAN_BATCH_SIZE,
	MAX_ORPHAN_SCAN_LIMIT,
	type OrphanCollector,
	type OrphanCollectorReport
} from '$lib/application/maintenance/orphan-collector';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import { resolveDeliveryWorkerSecret, type DeliveryWorkerSecretResolver } from './delivery-drain';
import { problemResponse } from './problem';

export const ORPHAN_SWEEP_BATCH_SIZE: number = DEFAULT_ORPHAN_BATCH_SIZE;
export const ORPHAN_SWEEP_MAX_OBJECTS: number = MAX_ORPHAN_SCAN_LIMIT;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type OrphanCollectorResolver = (
	context: ResolverContext
) => OrphanCollector | null | Promise<OrphanCollector | null>;

/**
 * Bounded object-store GC. Reuses `DELIVERY_WORKER_SECRET` rather than a new
 * credential. Grace period and scan limits are server-fixed so a caller cannot
 * request destructive collection of in-flight uploads.
 */
export function createOrphanSweepHandler(
	resolveCollector: OrphanCollectorResolver,
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

		let collector: OrphanCollector | null;
		try {
			collector = await resolveCollector({ platform });
		} catch (error: unknown) {
			logOrphanSweepError('orphan_sweep_resolution_failed', error);
			collector = null;
		}
		if (collector === null) {
			return problemResponse({
				type: 'urn:signkit:problem:orphan-sweep-unavailable',
				title: 'Orphan sweep unavailable',
				status: 503,
				detail: 'Object storage and its SQL reference store must be configured.',
				instance: url.pathname
			});
		}

		try {
			const report: OrphanCollectorReport = await collector.sweep({
				batchSize: ORPHAN_SWEEP_BATCH_SIZE,
				maxObjectsToScan: ORPHAN_SWEEP_MAX_OBJECTS
			});
			return Response.json(
				{
					scanned: report.scanned,
					referenced: report.referenced,
					inGracePeriod: report.inGracePeriod,
					deleted: report.deleted
				},
				{
					status: 200,
					headers: { 'cache-control': 'no-store' }
				}
			);
		} catch (error: unknown) {
			logOrphanSweepError('orphan_sweep_failed', error);
			return problemResponse({
				type: 'urn:signkit:problem:orphan-sweep-service-unavailable',
				title: 'Orphan sweep unavailable',
				status: 503,
				detail: 'The orphan sweep batch could not be processed.',
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

function logOrphanSweepError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
