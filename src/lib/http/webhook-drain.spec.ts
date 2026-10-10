import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { WebhookApplicationPort } from '$lib/application/webhooks/webhook-service';
import { MAINTENANCE_BATCH_OBSERVED_HEADER } from '$lib/observability/maintenance-telemetry';
import { createWebhookDrainHandler, type WebhookApplicationResolver } from './webhook-drain';
import { createDrainRequestEvent } from './drain-test-support';

const PATHNAME: string = '/api/v1/system/webhooks/drain';
const SECRET: string = 'delivery-worker-secret-0123456789abcdef';

function event(authorization?: string, platform?: App.Platform): RequestEvent {
	return createDrainRequestEvent(PATHNAME, authorization, platform);
}

function application(): WebhookApplicationPort {
	return {
		createEndpoint: vi.fn(),
		listEndpoints: vi.fn(),
		getEndpoint: vi.fn(),
		revokeEndpoint: vi.fn(),
		listDeliveryLogs: vi.fn(),
		drainPendingDeliveries: vi.fn(async () => ({
			claimed: 1,
			delivered: 1,
			retried: 0,
			failed: 0
		}))
	};
}

describe('webhook drain HTTP handler', () => {
	it.each([
		undefined,
		'Basic abc',
		'Bearer too-short',
		`Bearer  ${SECRET}`,
		`Bearer ${SECRET} extra`
	])('rejects malformed authorization before resolving webhooks: %s', async (authorization) => {
		const resolver: WebhookApplicationResolver = vi.fn(() => null);
		const response: Response = await createWebhookDrainHandler(
			resolver,
			() => SECRET
		)(event(authorization));
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(SECRET);
	});

	it('rejects a well-formed wrong secret before resolving webhooks', async () => {
		const resolver: WebhookApplicationResolver = vi.fn(() => null);
		const wrong: string = 'wrong-delivery-secret-0123456789abcdef';
		const response: Response = await createWebhookDrainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${wrong}`));
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('returns a secret-free drain batch after authentication', async () => {
		const app = application();
		const resolver: WebhookApplicationResolver = vi.fn(() => app);
		const response: Response = await createWebhookDrainHandler(
			resolver,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolver).toHaveBeenCalledWith({ platform: undefined });
		expect(app.drainPendingDeliveries).toHaveBeenCalledWith(25);
		const body = (await response.json()) as { claimed: number; delivered: number };
		expect(body).toEqual({ claimed: 1, delivered: 1, retried: 0, failed: 0 });
		expect(JSON.stringify(body)).not.toContain(SECRET);
	});

	it('marks a healthy batch observed, and logs a failure summary with duration when failed > 0', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const healthyResponse: Response = await createWebhookDrainHandler(
			() => application(),
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(healthyResponse.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledOnce();

		const failingApp: WebhookApplicationPort = {
			...application(),
			drainPendingDeliveries: vi.fn(async () => ({
				claimed: 2,
				delivered: 1,
				retried: 0,
				failed: 1
			}))
		};
		const failingResponse: Response = await createWebhookDrainHandler(
			() => failingApp,
			() => SECRET
		)(event(`Bearer ${SECRET}`));
		expect(failingResponse.headers.get(MAINTENANCE_BATCH_OBSERVED_HEADER)).toBe('1');
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toEqual(
			expect.objectContaining({
				event: 'scheduled_maintenance_batch_failed',
				job: 'webhook drain',
				claimed: 2,
				failed: 1
			})
		);
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});
});
