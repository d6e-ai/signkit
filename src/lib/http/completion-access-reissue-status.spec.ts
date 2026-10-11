import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyScope } from '$lib/security/api-key';
import type { CurrentCompletionDeliveryRow } from '$lib/ports/completion-access-reissue-row';
import {
	createCompletionAccessReissueStatusHandler,
	type CompletionAccessReissueStatusServiceResolver
} from './completion-access-reissue-status';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';

function bearerLocals(scopes: ApiKeyScope[]): App.Locals {
	return {
		apiKeyAuthentication: {
			state: 'authenticated',
			principal: {
				apiKeyId: '01900000-0000-7000-8000-000000000201',
				keyPrefix: 'signkit_abcdefgh',
				ownerUserId: 'user-1',
				scopes,
				expiresAt: '2026-12-11T00:00:00.000Z'
			}
		},
		identityState: 'anonymous',
		instanceMembership: null,
		bootstrapped: true,
		principal: null
	};
}

function event(input: {
	envelopeId?: string;
	state?: App.Locals['identityState'];
	locals?: App.Locals;
}): RequestEvent {
	const envelopeId: string = input.envelopeId ?? ENVELOPE_ID;
	return createHttpRequestEvent({
		method: 'GET',
		pathname: `/api/v1/envelopes/${envelopeId}/completion-deliveries`,
		locals: input.locals ?? instanceScopedLocals(input.state ?? 'active'),
		params: { envelopeId }
	});
}

function row(overrides: Partial<CurrentCompletionDeliveryRow> = {}): CurrentCompletionDeliveryRow {
	return {
		deliveryId: '01900000-0000-7000-8000-000000000010',
		recipientId: '01900000-0000-7000-8000-000000000011',
		recipientRole: 'signer',
		generation: 0,
		status: 'failed',
		attempts: 10,
		accessExpiresAt: '2026-10-10T00:00:00.000Z',
		accessRevokedAt: '2026-10-10T00:04:00.000Z',
		deliveredAt: null,
		failedAt: '2026-10-10T00:04:00.000Z',
		errorCode: 'completion_delivery_attempts_exhausted',
		failureCauseCode: null,
		eligibleForReissue: true,
		...overrides
	};
}

describe('completion access reissue status HTTP handler', () => {
	it('refuses anonymous callers and members without an active local membership before resolving persistence', async () => {
		for (const state of ['anonymous', 'no_membership', 'suspended'] as const) {
			const resolver: CompletionAccessReissueStatusServiceResolver = vi.fn(() => null);
			const response: Response = await createCompletionAccessReissueStatusHandler(resolver)(
				event({ state })
			);
			expect(response.status).toBeGreaterThanOrEqual(401);
			expect(response.status).toBeLessThanOrEqual(403);
			expect(resolver).not.toHaveBeenCalled();
		}
	});

	it('fails closed with 503 for an unresolvable identity state, never falling through to an authorized read', async () => {
		const resolver: CompletionAccessReissueStatusServiceResolver = vi.fn(() => null);
		const response: Response = await createCompletionAccessReissueStatusHandler(resolver)(
			event({ state: 'unavailable' })
		);
		expect(response.status).toBe(503);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('requires the envelopes:read scope for API keys, and a key missing it never reaches persistence', async () => {
		const resolver: CompletionAccessReissueStatusServiceResolver = vi.fn(() => null);
		const sendOnly: Response = await createCompletionAccessReissueStatusHandler(resolver)(
			event({ locals: bearerLocals(['envelopes:send']) })
		);
		expect(sendOnly.status).toBe(403);
		expect(await sendOnly.json()).toMatchObject({
			type: 'urn:signkit:problem:api-key-insufficient-scope'
		});
		expect(resolver).not.toHaveBeenCalled();

		const listCurrentDeliveries = vi.fn(async () => []);
		const reader: Response = await createCompletionAccessReissueStatusHandler(() => ({
			listCurrentDeliveries
		}))(event({ locals: bearerLocals(['envelopes:read']) }));
		expect(reader.status).toBe(200);
		expect(listCurrentDeliveries).toHaveBeenCalledWith(ENVELOPE_ID);
	});

	it('serves a plain operator session with no bearer presented', async () => {
		const listCurrentDeliveries = vi.fn(async () => [row()]);
		const response: Response = await createCompletionAccessReissueStatusHandler(() => ({
			listCurrentDeliveries
		}))(event({}));
		expect(response.status).toBe(200);
		expect(listCurrentDeliveries).toHaveBeenCalledWith(ENVELOPE_ID);
	});

	it('rejects a malformed envelope ID before resolving persistence', async () => {
		const resolver: CompletionAccessReissueStatusServiceResolver = vi.fn(() => null);
		const response: Response = await createCompletionAccessReissueStatusHandler(resolver)(
			event({ envelopeId: 'not-a-uuid' })
		);
		expect(response.status).toBe(400);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('returns only the allowlisted per-recipient generation fields, never a token or lease', async () => {
		const rows: CurrentCompletionDeliveryRow[] = [row()];
		const listCurrentDeliveries = vi.fn(async () => rows);
		const response: Response = await createCompletionAccessReissueStatusHandler(() => ({
			listCurrentDeliveries
		}))(event({}));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body: { completionDeliveries: CurrentCompletionDeliveryRow[] } = await response.json();
		expect(body.completionDeliveries).toEqual(rows);
		const serialized: string = JSON.stringify(body);
		expect(serialized).not.toContain('skca1_');
		expect(serialized).not.toContain('skcd1_');
		expect(serialized).not.toContain('claimToken');
		expect(serialized).not.toContain('sealedToken');
	});

	it('fails closed with 503 when the store throws', async () => {
		const listCurrentDeliveries = vi.fn(async () => {
			throw new Error('transient');
		});
		const response: Response = await createCompletionAccessReissueStatusHandler(() => ({
			listCurrentDeliveries
		}))(event({}));
		expect(response.status).toBe(503);
	});

	it('fails closed with 503 when the service resolver itself throws', async () => {
		const resolver: CompletionAccessReissueStatusServiceResolver = vi.fn(() => {
			throw new Error('resolution failed');
		});
		const response: Response = await createCompletionAccessReissueStatusHandler(resolver)(
			event({})
		);
		expect(response.status).toBe(503);
	});

	it('fails closed with 503 when the resolver resolves to no service', async () => {
		const response: Response = await createCompletionAccessReissueStatusHandler(() => null)(
			event({})
		);
		expect(response.status).toBe(503);
	});
});
