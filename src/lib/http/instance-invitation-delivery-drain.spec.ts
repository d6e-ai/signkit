import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceInvitationDeliveryService } from '$lib/application/instance-invitations/instance-invitation-delivery-service';
import {
	createInstanceInvitationDeliveryDrainHandler,
	type InstanceInvitationDeliveryServiceResolver
} from './instance-invitation-delivery-drain';
import { createDrainRequestEvent } from './drain-test-support';

const PATHNAME: string = '/api/v1/system/instance-invitations/drain';
const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

function event(authorization?: string, platform?: App.Platform): RequestEvent {
	return createDrainRequestEvent(PATHNAME, authorization, platform);
}

describe('instance invitation delivery drain HTTP handler', () => {
	it.each([undefined, 'Basic abc', 'Bearer too-short', `Bearer ${SECRET} extra`])(
		'rejects malformed authorization before resolving delivery: %s',
		async (authorization) => {
			const resolver: InstanceInvitationDeliveryServiceResolver = vi.fn(() => null);
			const response: Response = await createInstanceInvitationDeliveryDrainHandler(
				resolver,
				() => SECRET
			)(event(authorization));
			expect(response.status).toBe(401);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(resolver).not.toHaveBeenCalled();
			expect(await response.text()).not.toContain(SECRET);
		}
	);

	it('runs a bounded authenticated batch and fails closed without runtime', async () => {
		const service = {
			deliverPending: vi.fn(async () => ({ claimed: 0, delivered: 0, outcomes: [] }))
		};
		const response: Response = await createInstanceInvitationDeliveryDrainHandler(
			() => service as unknown as InstanceInvitationDeliveryService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(response.status).toBe(200);
		expect(service.deliverPending).toHaveBeenCalledWith(25);

		const unavailable: Response = await createInstanceInvitationDeliveryDrainHandler(
			() => null,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toMatchObject({
			type: 'urn:signkit:problem:instance-invitation-delivery-unavailable'
		});
	});
});
