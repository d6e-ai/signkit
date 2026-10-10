import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryResealSweepService } from '$lib/application/delivery/reseal-sweep-service';
import { MAINTENANCE_BATCH_OBSERVED_HEADER } from '$lib/observability/maintenance-telemetry';
import {
	createDeliveryResealSweepHandler,
	type DeliveryResealSweepServiceResolver
} from './delivery-reseal-sweep';
import { createDrainRequestEvent } from './drain-test-support';

const PATHNAME: string = '/api/v1/system/deliveries/reseal-sweep';
const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

function event(authorization?: string, platform?: App.Platform): RequestEvent {
	return createDrainRequestEvent(PATHNAME, authorization, platform);
}

function service() {
	return {
		resealOutstandingCapabilities: vi.fn(async () => ({
			discovered: 1,
			resealed: 1,
			stale: 0,
			unrecoverable: 0
		}))
	};
}

describe('delivery reseal sweep HTTP handler', () => {
	it.each([
		undefined,
		'Basic abc',
		'Bearer too-short',
		`Bearer  ${SECRET}`,
		`Bearer ${SECRET} extra`,
		`Bearer ${SECRET},Bearer ${SECRET}`
	])('rejects malformed authorization before resolving delivery: %s', async (authorization) => {
		const resolver: DeliveryResealSweepServiceResolver = vi.fn(() => null);
		const response: Response = await createDeliveryResealSweepHandler(
			resolver,
			() => SECRET
		)(event(authorization));

		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(SECRET);
	});

	it('rejects a well-formed wrong secret before resolving delivery', async () => {
		const resolver: DeliveryResealSweepServiceResolver = vi.fn(() => null);
		const wrong: string = 'wrong-delivery-secret-0123456789abcdef';
		const response: Response = await createDeliveryResealSweepHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${wrong}`));

		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(wrong);
	});

	it('passes platform only after authentication and returns a bounded batch result', async () => {
		const app = service();
		const resolver: DeliveryResealSweepServiceResolver = vi.fn(
			() => app as unknown as DeliveryResealSweepService
		);
		const platform = {
			env: { DELIVERY_WORKER_SECRET: SECRET }
		} as unknown as App.Platform;
		const response: Response = await createDeliveryResealSweepHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`, platform));

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolver).toHaveBeenCalledWith({ platform });
		expect(app.resealOutstandingCapabilities).toHaveBeenCalledWith(50);
		expect(await response.json()).toMatchObject({ discovered: 1, resealed: 1 });
	});

	it('fails closed when the worker secret or delivery runtime is unavailable', async () => {
		const missingSecret: Response = await createDeliveryResealSweepHandler(
			() => null,
			() => null
		)(event(`Bearer ${SECRET}`));
		const missingRuntime: Response = await createDeliveryResealSweepHandler(
			() => null,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(missingSecret.status).toBe(503);
		expect(missingRuntime.status).toBe(503);
	});

	it('does not expose thrown store details', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const app = service();
		app.resealOutstandingCapabilities.mockRejectedValueOnce(new Error(`database failed ${SECRET}`));
		const response: Response = await createDeliveryResealSweepHandler(
			() => app as unknown as DeliveryResealSweepService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		const body: string = await response.text();

		expect(response.status).toBe(503);
		expect(body).not.toContain(SECRET);
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'delivery_reseal_sweep_failed', message: 'Error' })
		);
		error.mockRestore();
	});

	it('marks a healthy batch observed, and logs a failure summary when unrecoverable > 0', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const healthyResponse: Response = await createDeliveryResealSweepHandler(
			() => service() as unknown as DeliveryResealSweepService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(healthyResponse.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledOnce();

		const failing = {
			resealOutstandingCapabilities: vi.fn(async () => ({
				discovered: 1,
				resealed: 0,
				stale: 0,
				unrecoverable: 1
			}))
		};
		const failingResponse: Response = await createDeliveryResealSweepHandler(
			() => failing as unknown as DeliveryResealSweepService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(failingResponse.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual(
			expect.objectContaining({
				event: 'scheduled_maintenance_batch_failed',
				job: 'delivery reseal sweep',
				unrecoverable: 1
			})
		);
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});
});
