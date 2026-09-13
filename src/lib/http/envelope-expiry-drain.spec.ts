import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { EnvelopeExpiryDrainService } from '$lib/application/delivery/envelope-expiry-service';
import {
	createEnvelopeExpiryDrainHandler,
	type EnvelopeExpiryDrainServiceResolver
} from './envelope-expiry-drain';
import { createDrainRequestEvent } from './drain-test-support';

const PATHNAME: string = '/api/v1/system/envelopes/expiry-drain';
const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

function event(authorization?: string, platform?: App.Platform): RequestEvent {
	return createDrainRequestEvent(PATHNAME, authorization, platform);
}

function service() {
	return {
		drainExpiredEnvelopes: vi.fn(async () => ({
			discovered: 1,
			expired: 1,
			skipped: 0,
			outcomes: [{ envelopeId: 'envelope-1', outcome: 'expired' as const }]
		}))
	};
}

describe('envelope expiry drain HTTP handler', () => {
	it.each([undefined, 'Basic abc', 'Bearer too-short'])(
		'rejects malformed authorization before resolving the drain: %s',
		async (authorization) => {
			const resolver: EnvelopeExpiryDrainServiceResolver = vi.fn(() => null);
			const response: Response = await createEnvelopeExpiryDrainHandler(
				resolver,
				() => SECRET
			)(event(authorization));

			expect(response.status).toBe(401);
			expect(resolver).not.toHaveBeenCalled();
			expect(await response.text()).not.toContain(SECRET);
		}
	);

	it('rejects a well-formed wrong secret before resolving the drain', async () => {
		const resolver: EnvelopeExpiryDrainServiceResolver = vi.fn(() => null);
		const wrong: string = 'wrong-delivery-secret-0123456789abcdef';
		const response: Response = await createEnvelopeExpiryDrainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${wrong}`));

		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(wrong);
	});

	it('passes platform only after authentication and returns a bounded batch result', async () => {
		const app = service();
		const resolver: EnvelopeExpiryDrainServiceResolver = vi.fn(
			() => app as unknown as EnvelopeExpiryDrainService
		);
		const platform = {
			env: { DELIVERY_WORKER_SECRET: SECRET }
		} as unknown as App.Platform;
		const response: Response = await createEnvelopeExpiryDrainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`, platform));

		expect(response.status).toBe(200);
		expect(resolver).toHaveBeenCalledWith({ platform });
		expect(app.drainExpiredEnvelopes).toHaveBeenCalledWith(25);
		expect(await response.json()).toMatchObject({ discovered: 1, expired: 1 });
	});

	it('fails closed when the worker secret or expiry runtime is unavailable', async () => {
		const missingSecret: Response = await createEnvelopeExpiryDrainHandler(
			() => null,
			() => null
		)(event(`Bearer ${SECRET}`));
		const missingRuntime: Response = await createEnvelopeExpiryDrainHandler(
			() => null,
			() => SECRET
		)(event(`Bearer ${SECRET}`));

		expect(missingSecret.status).toBe(503);
		expect(missingRuntime.status).toBe(503);
	});

	it('does not expose thrown store details', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const app = service();
		app.drainExpiredEnvelopes.mockRejectedValueOnce(new Error(`database failed ${SECRET}`));
		const response: Response = await createEnvelopeExpiryDrainHandler(
			() => app as unknown as EnvelopeExpiryDrainService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		const body: string = await response.text();

		expect(response.status).toBe(503);
		expect(body).not.toContain(SECRET);
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'envelope_expiry_drain_failed', message: 'Error' })
		);
		error.mockRestore();
	});
});
