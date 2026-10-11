import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentCompletionDeliveryRow } from '$lib/ports/completion-access-reissue-row';
import {
	createCompletionAccessReissueStatusHandler,
	type CompletionAccessReissueStatusPort,
	type CompletionAccessReissueStatusServiceResolver
} from './completion-access-reissue-status';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';

function event(
	envelopeId: string = ENVELOPE_ID,
	state: App.Locals['identityState'] = 'active'
): RequestEvent {
	return createHttpRequestEvent({
		pathname: `/api/v1/envelopes/${envelopeId}/completion-deliveries`,
		locals: instanceScopedLocals(state),
		params: { envelopeId }
	});
}

function port(
	listCurrentDeliveries: CompletionAccessReissueStatusPort['listCurrentDeliveries']
): CompletionAccessReissueStatusPort {
	return { listCurrentDeliveries };
}

const ROW: CurrentCompletionDeliveryRow = {
	deliveryId: 'delivery-1',
	recipientId: 'recipient-1',
	recipientRole: 'signer',
	generation: 1,
	status: 'failed',
	attempts: 10,
	accessExpiresAt: '2026-09-11T00:00:00.000Z',
	accessRevokedAt: '2026-09-11T00:05:00.000Z',
	deliveredAt: null,
	failedAt: '2026-09-11T00:05:00.000Z',
	errorCode: 'delivery_attempts_exhausted',
	failureCauseCode: 'mail_delivery_failed',
	eligibleForReissue: true
};

describe('completion access reissue status HTTP handler contract', () => {
	it('authorizes and validates the envelope ID before resolving persistence', async () => {
		const resolver: CompletionAccessReissueStatusServiceResolver = vi.fn(() => null);
		const unauthorized: Response = await createCompletionAccessReissueStatusHandler(resolver)(
			event(ENVELOPE_ID, 'anonymous')
		);
		const invalid: Response = await createCompletionAccessReissueStatusHandler(resolver)(
			event('not-a-uuid')
		);

		expect(unauthorized.status).toBe(401);
		expect(invalid.status).toBe(400);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('returns 404 for an envelope that does not exist, never conflating it with an empty listing', async () => {
		const listCurrentDeliveries = vi.fn(async () => null);
		const response: Response = await createCompletionAccessReissueStatusHandler(() =>
			port(listCurrentDeliveries)
		)(event());

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ type: 'urn:signkit:problem:envelope-not-found' });
	});

	it('returns 200 with an empty array for an existing envelope with no completion deliveries yet', async () => {
		const listCurrentDeliveries = vi.fn(async () => []);
		const response: Response = await createCompletionAccessReissueStatusHandler(() =>
			port(listCurrentDeliveries)
		)(event());

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ completionDeliveries: [] });
	});

	it('includes failureCauseCode on each listed delivery and nothing outside the explicit allowlist', async () => {
		const listCurrentDeliveries = vi.fn(async () => [ROW]);
		const response: Response = await createCompletionAccessReissueStatusHandler(() =>
			port(listCurrentDeliveries)
		)(event());
		const body: { completionDeliveries: Record<string, unknown>[] } = await response.json();

		expect(response.status).toBe(200);
		expect(body.completionDeliveries).toHaveLength(1);
		expect(body.completionDeliveries[0]).toEqual({
			deliveryId: 'delivery-1',
			recipientId: 'recipient-1',
			recipientRole: 'signer',
			generation: 1,
			status: 'failed',
			attempts: 10,
			accessExpiresAt: '2026-09-11T00:00:00.000Z',
			accessRevokedAt: '2026-09-11T00:05:00.000Z',
			deliveredAt: null,
			failedAt: '2026-09-11T00:05:00.000Z',
			errorCode: 'delivery_attempts_exhausted',
			failureCauseCode: 'mail_delivery_failed',
			eligibleForReissue: true
		});
		expect(Object.keys(body.completionDeliveries[0])).not.toContain('sealedToken');
		expect(Object.keys(body.completionDeliveries[0])).not.toContain('claimToken');
	});

	it('reports a historical row with no recoverable cause as failureCauseCode: null, never inferred', async () => {
		const historical: CurrentCompletionDeliveryRow = { ...ROW, failureCauseCode: null };
		const listCurrentDeliveries = vi.fn(async () => [historical]);
		const response: Response = await createCompletionAccessReissueStatusHandler(() =>
			port(listCurrentDeliveries)
		)(event());
		const body: { completionDeliveries: Record<string, unknown>[] } = await response.json();

		expect(body.completionDeliveries[0].failureCauseCode).toBeNull();
		expect(body.completionDeliveries[0].errorCode).toBe('delivery_attempts_exhausted');
	});

	it('answers 503 rather than propagating a store failure', async () => {
		const listCurrentDeliveries = vi.fn(async () => {
			throw new Error('store unavailable');
		});
		const response: Response = await createCompletionAccessReissueStatusHandler(() =>
			port(listCurrentDeliveries)
		)(event());

		expect(response.status).toBe(503);
	});
});
