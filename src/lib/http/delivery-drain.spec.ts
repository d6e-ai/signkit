import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { InvitationDeliveryService } from '$lib/application/delivery/delivery-service';
import {
	createDeliveryDrainHandler,
	type InvitationDeliveryServiceResolver
} from './delivery-drain';

const PATHNAME: string = '/api/v1/system/deliveries/drain';
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

function service() {
	return {
		deliverPendingInvitations: vi.fn(async () => ({
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

describe('delivery drain HTTP handler', () => {
	it.each([
		undefined,
		'Basic abc',
		'Bearer too-short',
		`Bearer  ${SECRET}`,
		`Bearer ${SECRET} extra`,
		`Bearer ${SECRET},Bearer ${SECRET}`
	])('rejects malformed authorization before resolving delivery: %s', async (authorization) => {
		const resolver: InvitationDeliveryServiceResolver = vi.fn(() => null);
		const response: Response = await createDeliveryDrainHandler(
			resolver,
			() => SECRET
		)(event(authorization));

		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(SECRET);
	});

	it('rejects a well-formed wrong secret before resolving delivery', async () => {
		const resolver: InvitationDeliveryServiceResolver = vi.fn(() => null);
		const wrong: string = 'wrong-delivery-secret-0123456789abcdef';
		const response: Response = await createDeliveryDrainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${wrong}`));

		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(wrong);
	});

	it('passes platform only after authentication and returns a bounded secret-free batch', async () => {
		const app = service();
		const resolver: InvitationDeliveryServiceResolver = vi.fn(
			() => app as unknown as InvitationDeliveryService
		);
		const platform = {
			env: { DELIVERY_WORKER_SECRET: SECRET }
		} as unknown as App.Platform;
		const response: Response = await createDeliveryDrainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`, platform));

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolver).toHaveBeenCalledWith({ platform });
		expect(app.deliverPendingInvitations).toHaveBeenCalledWith(25);
		expect(await response.json()).toMatchObject({ claimed: 1, delivered: 1 });
	});

	it('fails closed when the worker secret or delivery runtime is unavailable', async () => {
		const missingSecret: Response = await createDeliveryDrainHandler(
			() => null,
			() => null
		)(event(`Bearer ${SECRET}`));
		const missingRuntime: Response = await createDeliveryDrainHandler(
			() => null,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(missingSecret.status).toBe(503);
		expect(missingRuntime.status).toBe(503);
	});

	it('does not expose thrown provider details', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const app = service();
		app.deliverPendingInvitations.mockRejectedValueOnce(
			new Error(`SMTP failed ${SECRET} recipient@example.com`)
		);
		const response: Response = await createDeliveryDrainHandler(
			() => app as unknown as InvitationDeliveryService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		const body: string = await response.text();

		expect(response.status).toBe(503);
		expect(body).not.toContain(SECRET);
		expect(body).not.toContain('recipient@example.com');
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'delivery_drain_failed', message: 'Error' })
		);
		error.mockRestore();
	});
});
