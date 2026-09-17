import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { DeliveryStatusService } from '$lib/application/delivery/delivery-status';
import type { DeliveryStatusStore } from '$lib/ports/delivery-status-store';
import { createDeliveryStatusHandler, type DeliveryStatusServiceResolver } from './delivery-status';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';

function locals(state: App.Locals['identityState'] = 'active'): App.Locals {
	return instanceScopedLocals(state);
}

function event(
	envelopeId: string = ENVELOPE_ID,
	state: App.Locals['identityState'] = 'active'
): RequestEvent {
	return createHttpRequestEvent({
		pathname: `/api/v1/envelopes/${envelopeId}/deliveries`,
		locals: locals(state),
		params: { envelopeId }
	});
}

function service(find = vi.fn()) {
	const store: DeliveryStatusStore = { findEnvelopeDeliveryStatus: find };
	return new DeliveryStatusService(store);
}

describe('delivery status HTTP handler', () => {
	it('authorizes and validates the envelope ID before resolving persistence', async () => {
		const resolver: DeliveryStatusServiceResolver = vi.fn(() => null);
		const unauthorized: Response = await createDeliveryStatusHandler(resolver)(
			event(ENVELOPE_ID, 'anonymous')
		);
		const invalid: Response = await createDeliveryStatusHandler(resolver)(event('not-a-uuid'));

		expect(unauthorized.status).toBe(401);
		expect(invalid.status).toBe(400);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('scopes the query to the authenticated instance and returns no private delivery ID', async () => {
		const find = vi.fn(async () => ({
			envelopeId: ENVELOPE_ID,
			envelopeStatus: 'sent' as const,
			deliveries: [
				{
					deliveryId: 'private-outbox-1',
					recipientId: 'recipient-1',
					recipientRole: 'signer' as const,
					routingOrder: 1,
					status: 'pending' as const,
					attempts: 0,
					availableAt: '2026-09-12T00:00:00.000Z',
					deliveredAt: null,
					updatedAt: '2026-09-12T00:00:00.000Z',
					lastError: null
				}
			]
		}));
		const response: Response = await createDeliveryStatusHandler(() => service(find))(event());
		const body: string = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(find).toHaveBeenCalledWith(ENVELOPE_ID);
		expect(body).toContain('recipient-1');
		expect(body).not.toContain('private-outbox-1');
	});

	it('returns not found for a missing envelope', async () => {
		const find = vi.fn(async () => null);
		const response: Response = await createDeliveryStatusHandler(() => service(find))(event());

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:envelope-not-found'
		});
	});
});
