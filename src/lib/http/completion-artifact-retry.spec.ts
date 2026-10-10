import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyScope } from '$lib/security/api-key';
import {
	createCompletionArtifactRetryHandler,
	type CompletionArtifactRetryServiceResolver
} from './completion-artifact-retry';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const FAILED_AT: string = '2026-09-12T00:04:00.123456Z';

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
	headers?: HeadersInit;
	body?: string;
}): RequestEvent {
	const envelopeId: string = input.envelopeId ?? ENVELOPE_ID;
	return createHttpRequestEvent({
		method: 'POST',
		pathname: `/api/v1/envelopes/${envelopeId}/completion-artifact/retry`,
		locals: input.locals ?? instanceScopedLocals(input.state ?? 'active'),
		params: { envelopeId },
		headers: {
			'content-type': 'application/json',
			'idempotency-key': 'retry-1',
			...input.headers
		},
		body: input.body ?? JSON.stringify({ expectedAttempts: 10, expectedFailedAt: FAILED_AT })
	});
}

describe('completion artifact retry HTTP handler', () => {
	it('refuses anonymous callers and members without an active local membership before resolving persistence', async () => {
		for (const state of ['anonymous', 'no_membership'] as const) {
			const resolver: CompletionArtifactRetryServiceResolver = vi.fn(() => null);
			const response: Response = await createCompletionArtifactRetryHandler(resolver)(
				event({ state })
			);
			expect(response.status).toBeGreaterThanOrEqual(401);
			expect(response.status).toBeLessThanOrEqual(403);
			expect(resolver).not.toHaveBeenCalled();
		}
	});

	it('requires the envelopes:send scope for API keys', async () => {
		const resolver: CompletionArtifactRetryServiceResolver = vi.fn(() => null);
		const readOnly: Response = await createCompletionArtifactRetryHandler(resolver)(
			event({ locals: bearerLocals(['envelopes:read']) })
		);
		expect(readOnly.status).toBe(403);
		expect(resolver).not.toHaveBeenCalled();

		const retry = vi.fn(async () => ({
			outcome: 'requeued' as const,
			target: 'artifact' as const
		}));
		const sender: Response = await createCompletionArtifactRetryHandler(() => ({ retry }))(
			event({ locals: bearerLocals(['envelopes:send']) })
		);
		expect(sender.status).toBe(200);
	});

	it('requeues the observed exhausted generation', async () => {
		const retry = vi.fn(async () => ({
			outcome: 'requeued' as const,
			target: 'artifact' as const
		}));
		const response: Response = await createCompletionArtifactRetryHandler(() => ({ retry }))(
			event({})
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			requeued: { envelopeId: ENVELOPE_ID, target: 'artifact', outcome: 'requeued' }
		});
		expect(retry).toHaveBeenCalledWith({
			envelopeId: ENVELOPE_ID,
			idempotencyKey: 'retry-1',
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT
		});
	});

	it('rejects a command without the failure generation or with a malformed one', async () => {
		for (const body of [
			JSON.stringify({ expectedAttempts: 10 }),
			JSON.stringify({ expectedAttempts: 10, expectedFailedAt: 'yesterday' }),
			JSON.stringify({ expectedAttempts: 10, expectedFailedAt: FAILED_AT, extra: true })
		]) {
			const retry = vi.fn();
			const response: Response = await createCompletionArtifactRetryHandler(() => ({
				retry
			}))(event({ body }));
			expect(response.status).toBe(400);
			expect(retry).not.toHaveBeenCalled();
		}
	});

	it('requires an Idempotency-Key', async () => {
		const retry = vi.fn();
		const response: Response = await createCompletionArtifactRetryHandler(() => ({ retry }))(
			event({ headers: { 'idempotency-key': '' } })
		);
		expect(response.status).toBe(400);
		expect(retry).not.toHaveBeenCalled();
	});

	it('replays a duplicate command', async () => {
		const retry = vi.fn(async () => ({
			outcome: 'replayed' as const,
			target: 'artifact' as const
		}));
		const response: Response = await createCompletionArtifactRetryHandler(() => ({ retry }))(
			event({})
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
	});

	it('forbids integrity, budget, live-lease, and stale-generation retries', async () => {
		const retry = vi.fn(async () => ({ outcome: 'not_eligible' as const }));
		const response: Response = await createCompletionArtifactRetryHandler(() => ({ retry }))(
			event({})
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:completion-artifact-retry-not-eligible'
		});
	});

	it('conflicts when the Idempotency-Key was used for a different command', async () => {
		const retry = vi.fn(async () => ({ outcome: 'conflict' as const }));
		const response: Response = await createCompletionArtifactRetryHandler(() => ({ retry }))(
			event({})
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:completion-artifact-retry-idempotency-conflict'
		});
	});

	it('fails closed with 503 when the store throws', async () => {
		const retry = vi.fn(async () => {
			throw new Error('transient');
		});
		const response: Response = await createCompletionArtifactRetryHandler(() => ({ retry }))(
			event({})
		);
		expect(response.status).toBe(503);
	});
});
