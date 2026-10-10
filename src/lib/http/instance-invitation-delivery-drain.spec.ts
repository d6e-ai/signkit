import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceInvitationDeliveryService } from '$lib/application/instance-invitations/instance-invitation-delivery-service';
import { MAINTENANCE_BATCH_OBSERVED_HEADER } from '$lib/observability/maintenance-telemetry';
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

	it('marks a healthy batch observed, and logs a failure summary when permanentlyFailed > 0', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const healthy = {
			deliverPending: vi.fn(async () => ({ claimed: 0, delivered: 0, outcomes: [] }))
		};
		const healthyResponse: Response = await createInstanceInvitationDeliveryDrainHandler(
			() => healthy as unknown as InstanceInvitationDeliveryService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(healthyResponse.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledOnce();

		const failing = {
			deliverPending: vi.fn(async () => ({
				claimed: 1,
				delivered: 0,
				permanentlyFailed: 1,
				outcomes: []
			}))
		};
		const failingResponse: Response = await createInstanceInvitationDeliveryDrainHandler(
			() => failing as unknown as InstanceInvitationDeliveryService,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(failingResponse.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual(
			expect.objectContaining({
				event: 'scheduled_maintenance_batch_failed',
				job: 'instance invitation delivery drain',
				permanentlyFailed: 1
			})
		);
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});
});
