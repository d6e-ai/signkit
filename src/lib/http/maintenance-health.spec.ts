import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	MaintenanceBacklogCorruptionError,
	type MaintenanceBacklogPort
} from '$lib/observability/maintenance-backlog';
import {
	createMaintenanceHealthHandler,
	type MaintenanceBacklogPortResolver
} from './maintenance-health';

const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

function event(authorization?: string): RequestEvent {
	const url: URL = new URL('https://signkit.internal/api/v1/system/maintenance/health');
	const headers: Headers = new Headers();
	if (authorization !== undefined) headers.set('authorization', authorization);
	return { platform: undefined, request: new Request(url, { headers }), url } as RequestEvent;
}

function port(snapshot: ReturnType<MaintenanceBacklogPort['snapshot']>): MaintenanceBacklogPort {
	return { snapshot: vi.fn(() => snapshot) };
}

describe('maintenance health HTTP handler', () => {
	it.each([undefined, 'Basic abc', 'Bearer too-short', `Bearer ${SECRET} extra`])(
		'rejects malformed or missing authorization before resolving the backlog port: %s',
		async (authorization) => {
			const resolver: MaintenanceBacklogPortResolver = vi.fn(() => null);
			const response: Response = await createMaintenanceHealthHandler(
				resolver,
				() => SECRET
			)(event(authorization));

			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
			expect(await response.text()).not.toContain(SECRET);
		}
	);

	it('rejects a well-formed wrong secret', async () => {
		const resolver: MaintenanceBacklogPortResolver = vi.fn(() => null);
		const wrong: string = 'wrong-delivery-secret-0123456789abcdef';
		const response: Response = await createMaintenanceHealthHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${wrong}`));

		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('returns 503 when the backlog port cannot be resolved', async () => {
		const resolver: MaintenanceBacklogPortResolver = vi.fn(() => null);
		const response: Response = await createMaintenanceHealthHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(response.status).toBe(503);
	});

	it('returns the bounded backlog snapshot for an authorized caller', async () => {
		const snapshot = [
			{
				queue: 'pdf_seal' as const,
				pendingCount: 1,
				oldestPendingAgeSeconds: 300,
				oldestOverdueAgeSeconds: 120,
				permanentlyFailedCount: 0
			}
		];
		const resolver: MaintenanceBacklogPortResolver = vi.fn(() => port(Promise.resolve(snapshot)));
		const response: Response = await createMaintenanceHealthHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ queues: snapshot });
	});

	it('returns 503 and logs no raw error when the snapshot query fails', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const failingPort: MaintenanceBacklogPort = {
			snapshot: vi.fn(async () => {
				throw new Error('contains a connection string with a secret');
			})
		};
		const resolver: MaintenanceBacklogPortResolver = vi.fn(() => failingPort);
		const response: Response = await createMaintenanceHealthHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(response.status).toBe(503);
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
			event: 'maintenance_health_query_failed',
			message: 'Error'
		});
		errorSpy.mockRestore();
	});

	it('returns 503 and logs no raw timestamp when a backlog row has a corrupted age', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const failingPort: MaintenanceBacklogPort = {
			snapshot: vi.fn(async () => {
				throw new MaintenanceBacklogCorruptionError('pdf_seal', 'created_at');
			})
		};
		const resolver: MaintenanceBacklogPortResolver = vi.fn(() => failingPort);
		const response: Response = await createMaintenanceHealthHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(response.status).toBe(503);
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual({
			event: 'maintenance_health_query_failed',
			message: 'MaintenanceBacklogCorruptionError'
		});
		errorSpy.mockRestore();
	});
});
