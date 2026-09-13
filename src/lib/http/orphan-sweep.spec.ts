import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_ORPHAN_GRACE_PERIOD_MS,
	type OrphanCollector
} from '$lib/application/maintenance/orphan-collector';
import {
	createOrphanSweepHandler,
	ORPHAN_SWEEP_BATCH_SIZE,
	ORPHAN_SWEEP_MAX_OBJECTS,
	type OrphanCollectorResolver
} from './orphan-sweep';
import { createDrainRequestEvent } from './drain-test-support';

const PATHNAME: string = '/api/v1/system/objects/orphan-sweep';
const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

function event(authorization?: string, platform?: App.Platform): RequestEvent {
	return createDrainRequestEvent(PATHNAME, authorization, platform);
}

function collector() {
	return {
		sweep: vi.fn(async () => ({
			scanned: 3,
			referenced: 1,
			inGracePeriod: 1,
			deleted: 1,
			deletedKeys: ['drafts/secret-orphan.git.gz']
		}))
	};
}

describe('orphan sweep HTTP handler', () => {
	it.each([
		undefined,
		'Basic abc',
		'Bearer too-short',
		`Bearer  ${SECRET}`,
		`Bearer ${SECRET} extra`
	])('rejects malformed authorization before resolving the sweep: %s', async (authorization) => {
		const resolver: OrphanCollectorResolver = vi.fn(() => null);
		const response: Response = await createOrphanSweepHandler(
			resolver,
			() => SECRET
		)(event(authorization));

		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(SECRET);
	});

	it('rejects a well-formed wrong secret before resolving the sweep', async () => {
		const resolver: OrphanCollectorResolver = vi.fn(() => null);
		const wrong: string = 'wrong-delivery-secret-0123456789abcdef';
		const response: Response = await createOrphanSweepHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${wrong}`));

		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(wrong);
	});

	it('passes platform only after authentication and returns bounded counts without object keys', async () => {
		const app = collector();
		const resolver: OrphanCollectorResolver = vi.fn(() => app as unknown as OrphanCollector);
		const platform = {
			env: { DELIVERY_WORKER_SECRET: SECRET }
		} as unknown as App.Platform;
		const response: Response = await createOrphanSweepHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`, platform));
		const body: unknown = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolver).toHaveBeenCalledWith({ platform });
		expect(app.sweep).toHaveBeenCalledWith({
			batchSize: ORPHAN_SWEEP_BATCH_SIZE,
			maxObjectsToScan: ORPHAN_SWEEP_MAX_OBJECTS
		});
		expect(body).toEqual({ scanned: 3, referenced: 1, inGracePeriod: 1, deleted: 1 });
		expect(JSON.stringify(body)).not.toContain('secret-orphan');
		expect(JSON.stringify(body)).not.toContain(SECRET);
		expect(ORPHAN_SWEEP_BATCH_SIZE).toBeLessThanOrEqual(ORPHAN_SWEEP_MAX_OBJECTS);
		expect(DEFAULT_ORPHAN_GRACE_PERIOD_MS).toBe(24 * 60 * 60 * 1000);
	});

	it('fails closed when the worker secret or orphan runtime is unavailable', async () => {
		const missingSecret: Response = await createOrphanSweepHandler(
			() => null,
			() => null
		)(event(`Bearer ${SECRET}`));
		const missingRuntime: Response = await createOrphanSweepHandler(
			() => null,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(missingSecret.status).toBe(503);
		expect(missingRuntime.status).toBe(503);
	});

	it('observes a lost checkpoint compare-and-swap without failing the request', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const app = {
			sweep: vi.fn(async () => ({
				scanned: 3,
				referenced: 1,
				inGracePeriod: 1,
				deleted: 1,
				deletedKeys: ['drafts/secret-orphan.git.gz'],
				checkpointConflict: true
			}))
		};
		const response: Response = await createOrphanSweepHandler(
			() => app as unknown as OrphanCollector,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		const body: unknown = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ scanned: 3, referenced: 1, inGracePeriod: 1, deleted: 1 });
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'orphan_sweep_checkpoint_conflict' })
		);
		error.mockRestore();
	});

	it('does not expose thrown store details', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const app = collector();
		app.sweep.mockRejectedValueOnce(new Error(`database failed ${SECRET}`));
		const response: Response = await createOrphanSweepHandler(
			() => app as unknown as OrphanCollector,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		const body: string = await response.text();

		expect(response.status).toBe(503);
		expect(body).not.toContain(SECRET);
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'orphan_sweep_failed', message: 'Error' })
		);
		error.mockRestore();
	});
});
