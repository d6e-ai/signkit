import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceDisplayMaintenanceService } from '$lib/application/instance-display/instance-display-maintenance-service';
import { MAINTENANCE_BATCH_OBSERVED_HEADER } from '$lib/observability/maintenance-telemetry';
import { createDrainRequestEvent } from './drain-test-support';
import {
	createInstanceDisplayMaintainHandler,
	type InstanceDisplayMaintenanceServiceResolver
} from './instance-display-maintain';

const PATHNAME: string = '/api/v1/system/instance-display/maintain';
const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

function event(authorization?: string, platform?: App.Platform): RequestEvent {
	return createDrainRequestEvent(PATHNAME, authorization, platform);
}

describe('instance display maintain HTTP handler', () => {
	it('rejects malformed authorization before resolving the store', async () => {
		const resolver: InstanceDisplayMaintenanceServiceResolver = vi.fn(() => null);
		const response: Response = await createInstanceDisplayMaintainHandler(
			resolver,
			() => SECRET
		)(event('Bearer too-short'));
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('returns bounded cleanup and reseal counts without requiring mail configuration', async () => {
		const app = {
			maintain: vi.fn(async () => ({
				expired: 2,
				deleted: 1,
				discovered: 3,
				resealed: 2,
				stale: 1,
				unrecoverable: 0
			}))
		};
		const resolver: InstanceDisplayMaintenanceServiceResolver = vi.fn(
			() => app as unknown as InstanceDisplayMaintenanceService
		);
		const platform = { env: { DELIVERY_WORKER_SECRET: SECRET } } as unknown as App.Platform;
		const response: Response = await createInstanceDisplayMaintainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`, platform));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
		expect(app.maintain).toHaveBeenCalledWith(100, 50);
		expect(await response.json()).toEqual({
			expired: 2,
			deleted: 1,
			discovered: 3,
			resealed: 2,
			stale: 1,
			unrecoverable: 0
		});
	});
});
