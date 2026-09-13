import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { CompletionDeliveryResealSweepService } from '$lib/application/completion-delivery/completion-reseal-sweep-service';
import {
	createCompletionDeliveryResealSweepHandler,
	type CompletionDeliveryResealSweepServiceResolver
} from './completion-delivery-reseal-sweep';
import { createDrainRequestEvent } from './drain-test-support';

const PATHNAME: string = '/api/v1/system/completion-deliveries/reseal-sweep';
const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

function event(authorization?: string, platform?: App.Platform): RequestEvent {
	return createDrainRequestEvent(PATHNAME, authorization, platform);
}

function service() {
	return {
		resealOutstandingTokens: vi.fn(async () => ({
			discovered: 1,
			resealed: 1,
			stale: 0,
			unrecoverable: 0
		}))
	};
}

describe('completion delivery reseal sweep HTTP handler', () => {
	it.each([undefined, 'Basic abc', 'Bearer too-short'])(
		'rejects malformed authorization before resolving delivery: %s',
		async (authorization) => {
			const resolver: CompletionDeliveryResealSweepServiceResolver = vi.fn(() => null);
			const response: Response = await createCompletionDeliveryResealSweepHandler(
				resolver,
				() => SECRET
			)(event(authorization));

			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
			expect(await response.text()).not.toContain(SECRET);
		}
	);

	it('rejects a well-formed wrong secret before resolving delivery', async () => {
		const resolver: CompletionDeliveryResealSweepServiceResolver = vi.fn(() => null);
		const wrong: string = 'wrong-delivery-secret-0123456789abcdef';
		const response: Response = await createCompletionDeliveryResealSweepHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${wrong}`));

		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(wrong);
	});

	it('passes platform only after authentication and returns a bounded batch result', async () => {
		const app = service();
		const resolver: CompletionDeliveryResealSweepServiceResolver = vi.fn(
			() => app as unknown as CompletionDeliveryResealSweepService
		);
		const platform = {
			env: { DELIVERY_WORKER_SECRET: SECRET }
		} as unknown as App.Platform;
		const response: Response = await createCompletionDeliveryResealSweepHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`, platform));

		expect(response.status).toBe(200);
		expect(resolver).toHaveBeenCalledWith({ platform });
		expect(app.resealOutstandingTokens).toHaveBeenCalledWith(50);
		expect(await response.json()).toMatchObject({ discovered: 1, resealed: 1 });
	});

	it('fails closed when the worker secret or delivery runtime is unavailable', async () => {
		const missingSecret: Response = await createCompletionDeliveryResealSweepHandler(
			() => null,
			() => null
		)(event(`Bearer ${SECRET}`));
		const missingRuntime: Response = await createCompletionDeliveryResealSweepHandler(
			() => null,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(missingSecret.status).toBe(503);
		expect(missingRuntime.status).toBe(503);
	});

	it('does not expose thrown store details', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const app = service();
		app.resealOutstandingTokens.mockRejectedValueOnce(new Error(`database failed ${SECRET}`));
		const response: Response = await createCompletionDeliveryResealSweepHandler(
			() => app as unknown as CompletionDeliveryResealSweepService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		const body: string = await response.text();

		expect(response.status).toBe(503);
		expect(body).not.toContain(SECRET);
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'completion_delivery_reseal_sweep_failed', message: 'Error' })
		);
		error.mockRestore();
	});
});
