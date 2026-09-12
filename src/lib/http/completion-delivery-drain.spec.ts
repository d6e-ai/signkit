import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { CompletionDeliveryService } from '$lib/application/completion-delivery/completion-delivery-service';
import {
	createCompletionDeliveryDrainHandler,
	type CompletionDeliveryServiceResolver
} from './completion-delivery-drain';

const PATHNAME: string = '/api/v1/system/completion-deliveries/drain';
const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

function event(authorization?: string, platform?: App.Platform): RequestEvent {
	const url: URL = new URL(`https://signkit.internal${PATHNAME}`);
	const headers: Headers = new Headers();
	if (authorization !== undefined) headers.set('authorization', authorization);
	return {
		platform,
		request: new Request(url, { method: 'POST', headers }),
		url
	} as RequestEvent;
}

function mockService() {
	return {
		deliverPendingCompletions: vi.fn(async () => ({
			discovered: 1,
			seeded: 1,
			claimed: 1,
			delivered: 1,
			retryableFailed: 0,
			permanentlyFailed: 0,
			integrityFailed: 0,
			stale: 0,
			outcomes: [{ deliveryId: 'delivery-1', outcome: 'delivered' as const }]
		}))
	};
}

describe('completion delivery drain HTTP handler', () => {
	it.each([
		undefined,
		'Basic abc',
		'Bearer too-short',
		`Bearer  ${SECRET}`,
		`Bearer ${SECRET} extra`,
		`Bearer ${SECRET},Bearer ${SECRET}`
	])('rejects malformed authorization before resolving delivery: %s', async (authorization) => {
		const resolver: CompletionDeliveryServiceResolver = vi.fn(() => null);
		const response: Response = await createCompletionDeliveryDrainHandler(
			resolver,
			() => SECRET
		)(event(authorization));

		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(SECRET);
	});

	it('rejects a well-formed wrong secret before resolving delivery', async () => {
		const resolver: CompletionDeliveryServiceResolver = vi.fn(() => null);
		const wrong: string = 'wrong-delivery-secret-0123456789abcdef';
		const response: Response = await createCompletionDeliveryDrainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${wrong}`));

		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(wrong);
	});

	it('passes platform only after authentication and returns a bounded secret-free batch with max 25', async () => {
		const app = mockService();
		const resolver: CompletionDeliveryServiceResolver = vi.fn(
			() => app as unknown as CompletionDeliveryService
		);
		const platform = {
			env: { DELIVERY_WORKER_SECRET: SECRET }
		} as unknown as App.Platform;
		const response: Response = await createCompletionDeliveryDrainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`, platform));

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolver).toHaveBeenCalledWith({ platform });
		expect(app.deliverPendingCompletions).toHaveBeenCalledWith(25);
		expect(await response.json()).toMatchObject({ claimed: 1, delivered: 1 });
	});

	it('fails closed when the worker secret or delivery runtime is unavailable', async () => {
		const missingSecret: Response = await createCompletionDeliveryDrainHandler(
			() => null,
			() => null
		)(event(`Bearer ${SECRET}`));
		const missingRuntime: Response = await createCompletionDeliveryDrainHandler(
			() => null,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(missingSecret.status).toBe(503);
		expect(await missingSecret.json()).toMatchObject({
			type: 'urn:signkit:problem:delivery-worker-unavailable'
		});

		expect(missingRuntime.status).toBe(503);
		expect(await missingRuntime.json()).toMatchObject({
			type: 'urn:signkit:problem:completion-delivery-unavailable'
		});
	});

	it('returns 503 problem response when service throws during drain batch processing', async () => {
		const app = {
			deliverPendingCompletions: vi.fn().mockRejectedValue(new Error('Batch processing failed'))
		};
		const response: Response = await createCompletionDeliveryDrainHandler(
			() => app as unknown as CompletionDeliveryService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:completion-delivery-service-unavailable'
		});
	});
});
