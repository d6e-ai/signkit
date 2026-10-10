import type { RequestHandler } from '@sveltejs/kit';
import {
	MAX_ORPHAN_SCAN_LIMIT,
	OrphanSweepFailure,
	type OrphanCollector,
	type OrphanCollectorReport
} from '$lib/application/maintenance/orphan-collector';
import { maintenanceFailureHeaders } from '$lib/observability/maintenance-failure';
import { parseBearerSecret, secretsEqual } from '$lib/security/bearer-secret';
import { resolveDeliveryWorkerSecret, type DeliveryWorkerSecretResolver } from './delivery-drain';
import { problemResponse } from './problem';

export const ORPHAN_SWEEP_BATCH_SIZE: number = MAX_ORPHAN_SCAN_LIMIT;
export const ORPHAN_SWEEP_MAX_OBJECTS: number = MAX_ORPHAN_SCAN_LIMIT;
export const ORPHAN_SWEEP_MAX_LIST_PAGES: number = 1;

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
		let resolutionFailed: boolean = false;
		try {
			collector = await resolveCollector({ platform });
		} catch {
			logOrphanSweepError('orphan_sweep_resolution_failed', {
				code: 'runtime_resolution_failed',
				operation: 'runtime_resolution'
			});
			resolutionFailed = true;
			collector = null;
		}
		if (collector === null) {
			return problemResponse(
				{
					type: 'urn:signkit:problem:orphan-sweep-unavailable',
					title: 'Orphan sweep unavailable',
					status: 503,
					detail: 'Object storage and its SQL reference store must be configured.',
					instance: url.pathname
				},
				resolutionFailed ? maintenanceFailureHeaders('runtime_resolution_failed') : undefined
			);
		}

		try {
			const report: OrphanCollectorReport = await collector.sweep({
				batchSize: ORPHAN_SWEEP_BATCH_SIZE,
				maxObjectsToScan: ORPHAN_SWEEP_MAX_OBJECTS,
				maxListPages: ORPHAN_SWEEP_MAX_LIST_PAGES
			});
			if (report.checkpointConflict) {
				// A concurrent sweep already advanced the checkpoint past this run's
				// start point. This run's scan and any deletions above already
				// completed and are not retried, so there is no duplicate deletion;
				// the next sweep resumes from whatever the winning writer stored, so
				// there is no livelock. Only the durable checkpoint bookkeeping lost
				// the race, so this is reported, not treated as a failure.
				logOrphanSweepEvent('orphan_sweep_checkpoint_conflict');
			}
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
			const failure: OrphanSweepLogContext = orphanSweepLogContext(error);
			logOrphanSweepError('orphan_sweep_failed', failure);
			return problemResponse(
				{
					type: 'urn:signkit:problem:orphan-sweep-service-unavailable',
					title: 'Orphan sweep unavailable',
					status: 503,
					detail: 'The orphan sweep batch could not be processed.',
					instance: url.pathname
				},
				maintenanceFailureHeaders(failure.code)
			);
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

interface OrphanSweepLogContext {
	readonly code: string;
	readonly operation: string;
}

function orphanSweepLogContext(error: unknown): OrphanSweepLogContext {
	if (error instanceof OrphanSweepFailure) {
		return { code: error.code, operation: error.operation };
	}
	return { code: 'unexpected_failure', operation: 'unknown' };
}

function logOrphanSweepError(event: string, context: OrphanSweepLogContext): void {
	console.error(
		JSON.stringify({
			event,
			code: context.code,
			operation: context.operation
		})
	);
}

function logOrphanSweepEvent(event: string): void {
	console.error(JSON.stringify({ event }));
}
