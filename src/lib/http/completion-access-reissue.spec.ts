import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyScope } from '$lib/security/api-key';
import type { ReissueCompletionAccessResult } from '$lib/application/completion-delivery/completion-access-reissue-service';
import type { PublishedCompletionAccessReissue } from '$lib/ports/completion-access-reissue';
import {
	completionAccessReissueBodySchema,
	createCompletionAccessReissueHandler,
	type CompletionAccessReissueServiceResolver
} from './completion-access-reissue';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01900000-0000-7000-8000-000000000002';
const DELIVERY_ID: string = '01900000-0000-7000-8000-000000000003';
const FAILED_AT: string = '2026-10-10T00:04:00.123456Z';
const ERROR_CODE: string = 'completion_delivery_attempts_exhausted';

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

function validBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		grantAccess: true,
		expectedDeliveryId: DELIVERY_ID,
		expectedAttempts: 10,
		expectedFailedAt: FAILED_AT,
		expectedErrorCode: ERROR_CODE,
		...overrides
	});
}

function event(input: {
	envelopeId?: string;
	recipientId?: string;
	state?: App.Locals['identityState'];
	locals?: App.Locals;
	headers?: HeadersInit;
	body?: string;
}): RequestEvent {
	const envelopeId: string = input.envelopeId ?? ENVELOPE_ID;
	const recipientId: string = input.recipientId ?? RECIPIENT_ID;
	return createHttpRequestEvent({
		method: 'POST',
		pathname: `/api/v1/envelopes/${envelopeId}/recipients/${recipientId}/completion-access/reissue`,
		locals: input.locals ?? instanceScopedLocals(input.state ?? 'active'),
		params: { envelopeId, recipientId },
		headers: {
			'content-type': 'application/json',
			'idempotency-key': 'reissue-1',
			...input.headers
		},
		body: input.body ?? validBody()
	});
}

function publishedResult(): PublishedCompletionAccessReissue {
	return {
		envelopeId: ENVELOPE_ID,
		recipientId: RECIPIENT_ID,
		deliveryId: 'new-delivery-1',
		generation: 1,
		accessExpiresAt: '2026-11-09T00:04:00.000Z',
		reissuedAt: '2026-10-10T00:05:00.000Z',
		auditEventId: 'audit-event-1'
	};
}

function published(): ReissueCompletionAccessResult {
	return { outcome: 'published', result: publishedResult() };
}

describe('completion access reissue HTTP handler', () => {
	it('refuses anonymous callers and members without an active local membership before resolving persistence', async () => {
		for (const state of ['anonymous', 'no_membership', 'suspended'] as const) {
			const resolver: CompletionAccessReissueServiceResolver = vi.fn(() => null);
			const response: Response = await createCompletionAccessReissueHandler(resolver)(
				event({ state })
			);
			expect(response.status).toBeGreaterThanOrEqual(401);
			expect(response.status).toBeLessThanOrEqual(403);
			expect(resolver).not.toHaveBeenCalled();
		}
	});

	it('fails closed with 503 for an unresolvable identity state, never falling through to an authorized mutation', async () => {
		const resolver: CompletionAccessReissueServiceResolver = vi.fn(() => null);
		const response: Response = await createCompletionAccessReissueHandler(resolver)(
			event({ state: 'unavailable' })
		);
		expect(response.status).toBe(503);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('requires the envelopes:send scope for API keys -- a read-only key is forbidden to POST', async () => {
		const resolver: CompletionAccessReissueServiceResolver = vi.fn(() => null);
		const readOnly: Response = await createCompletionAccessReissueHandler(resolver)(
			event({ locals: bearerLocals(['envelopes:read']) })
		);
		expect(readOnly.status).toBe(403);
		expect(await readOnly.json()).toMatchObject({
			type: 'urn:signkit:problem:api-key-insufficient-scope'
		});
		expect(resolver).not.toHaveBeenCalled();

		const reissue = vi.fn(async (): Promise<ReissueCompletionAccessResult> => published());
		const sender: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({ locals: bearerLocals(['envelopes:send']) })
		);
		expect(sender.status).toBe(200);
		expect(reissue).toHaveBeenCalledTimes(1);
	});

	it('serves a plain operator session with no bearer presented', async () => {
		const reissue = vi.fn(async (): Promise<ReissueCompletionAccessResult> => published());
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({})
		);
		expect(response.status).toBe(200);
		expect(reissue).toHaveBeenCalledWith(
			{ type: 'user', id: 'user-1' },
			{
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				idempotencyKey: 'reissue-1',
				expectedDeliveryId: DELIVERY_ID,
				expectedAttempts: 10,
				expectedFailedAt: FAILED_AT,
				expectedErrorCode: ERROR_CODE
			}
		);
	});

	it('attributes an API-key actor as an agent, never as the key owner user', async () => {
		const reissue = vi.fn(async (): Promise<ReissueCompletionAccessResult> => published());
		await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({ locals: bearerLocals(['envelopes:send']) })
		);
		expect(reissue).toHaveBeenCalledWith(
			{ type: 'agent', id: '01900000-0000-7000-8000-000000000201' },
			expect.anything()
		);
	});

	it('rejects malformed envelope/recipient IDs before resolving persistence', async () => {
		const resolver: CompletionAccessReissueServiceResolver = vi.fn(() => null);
		const badEnvelope: Response = await createCompletionAccessReissueHandler(resolver)(
			event({ envelopeId: 'not-a-uuid' })
		);
		expect(badEnvelope.status).toBe(400);
		const badRecipient: Response = await createCompletionAccessReissueHandler(resolver)(
			event({ recipientId: 'not-a-uuid' })
		);
		expect(badRecipient.status).toBe(400);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('requires a non-empty visible-ASCII Idempotency-Key', async () => {
		const reissue = vi.fn();
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({ headers: { 'idempotency-key': '' } })
		);
		expect(response.status).toBe(400);
		expect(reissue).not.toHaveBeenCalled();
	});

	it.each([
		JSON.stringify({
			expectedDeliveryId: DELIVERY_ID,
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: ERROR_CODE
		}),
		JSON.stringify({
			grantAccess: false,
			expectedDeliveryId: DELIVERY_ID,
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: ERROR_CODE
		}),
		JSON.stringify({
			grantAccess: true,
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: ERROR_CODE
		}),
		JSON.stringify({
			grantAccess: true,
			expectedDeliveryId: 'not-a-uuid',
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: ERROR_CODE
		}),
		JSON.stringify({
			grantAccess: true,
			expectedDeliveryId: DELIVERY_ID,
			expectedAttempts: -1,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: ERROR_CODE
		}),
		JSON.stringify({
			grantAccess: true,
			expectedDeliveryId: DELIVERY_ID,
			expectedAttempts: 1.5,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: ERROR_CODE
		}),
		JSON.stringify({
			grantAccess: true,
			expectedDeliveryId: DELIVERY_ID,
			expectedAttempts: 10,
			expectedFailedAt: 'yesterday',
			expectedErrorCode: ERROR_CODE
		}),
		JSON.stringify({
			grantAccess: true,
			expectedDeliveryId: DELIVERY_ID,
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: 'Not-Lowercase'
		}),
		JSON.stringify({
			grantAccess: true,
			expectedDeliveryId: DELIVERY_ID,
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: ''
		}),
		JSON.stringify({
			grantAccess: true,
			expectedDeliveryId: DELIVERY_ID,
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: ERROR_CODE,
			extra: true
		})
	])(
		'rejects a command missing grantAccess or carrying a malformed expected-generation tuple: %s',
		async (body) => {
			const reissue = vi.fn();
			const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
				event({ body })
			);
			expect(response.status).toBe(400);
			expect(reissue).not.toHaveBeenCalled();
		}
	);

	it('rejects non-JSON content types', async () => {
		const reissue = vi.fn();
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({ headers: { 'content-type': 'text/plain' } })
		);
		expect(response.status).toBe(415);
		expect(reissue).not.toHaveBeenCalled();
	});

	it('rejects invalid JSON bodies', async () => {
		const reissue = vi.fn();
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({ body: '{not json' })
		);
		expect(response.status).toBe(400);
		expect(reissue).not.toHaveBeenCalled();
	});

	it('publishes a new generation with a 200 and the allowlisted receipt', async () => {
		const reissue = vi.fn(async (): Promise<ReissueCompletionAccessResult> => published());
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({})
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('idempotency-replayed')).toBeNull();
		const body = await response.json();
		expect(body).toEqual({
			completionAccessReissue: {
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				deliveryId: 'new-delivery-1',
				generation: 1,
				accessExpiresAt: '2026-11-09T00:04:00.000Z',
				reissuedAt: '2026-10-10T00:05:00.000Z'
			}
		});
	});

	it('replays a safe same-key duplicate with the idempotency-replayed header', async () => {
		const reissue = vi.fn(async (): Promise<ReissueCompletionAccessResult> => ({
			outcome: 'replayed',
			result: publishedResult()
		}));
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({})
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
	});

	it('returns 404 for an unknown envelope, recipient or predecessor delivery', async () => {
		const reissue = vi.fn(async (): Promise<ReissueCompletionAccessResult> => ({
			outcome: 'not_found'
		}));
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({})
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ type: 'urn:signkit:problem:envelope-not-found' });
	});

	it.each([
		'envelope_not_completed',
		'recipient_not_eligible',
		'predecessor_not_terminal'
	] as const)('returns 409 not-eligible for reason %s', async (reason) => {
		const reissue = vi.fn(async (): Promise<ReissueCompletionAccessResult> => ({
			outcome: 'not_eligible',
			reason
		}));
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({})
		);
		expect(response.status).toBe(409);
		const body: { type: string; detail: string } = await response.json();
		expect(body.type).toBe('urn:signkit:problem:completion-access-reissue-not-eligible');
		expect(body.detail).toContain(reason);
	});

	it('returns 409 stale-generation for a different-key request against an already-superseded generation', async () => {
		const reissue = vi.fn(async (): Promise<ReissueCompletionAccessResult> => ({
			outcome: 'stale_generation'
		}));
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({})
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:completion-access-reissue-stale-generation'
		});
	});

	it('returns 409 idempotency-conflict for a same-key request with a changed body', async () => {
		const reissue = vi.fn(async (): Promise<ReissueCompletionAccessResult> => ({
			outcome: 'idempotency_conflict'
		}));
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({})
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:idempotency-key-conflict'
		});
	});

	it('returns 409 artifact-unavailable when the completion manifest/PDF are not published yet', async () => {
		const reissue = vi.fn(async (): Promise<ReissueCompletionAccessResult> => ({
			outcome: 'artifact_unavailable'
		}));
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({})
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:completion-access-reissue-artifact-unavailable'
		});
	});

	it('returns 503 integrity-error when the write-time artifact recheck fails', async () => {
		const reissue = vi.fn(async (): Promise<ReissueCompletionAccessResult> => ({
			outcome: 'integrity_error'
		}));
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({})
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:completion-access-reissue-integrity-error'
		});
	});

	it('fails closed with 503 when the store throws', async () => {
		const reissue = vi.fn(async () => {
			throw new Error('transient');
		});
		const response: Response = await createCompletionAccessReissueHandler(() => ({ reissue }))(
			event({})
		);
		expect(response.status).toBe(503);
	});

	it('fails closed with 503 when the resolver resolves to no service', async () => {
		const response: Response = await createCompletionAccessReissueHandler(() => null)(event({}));
		expect(response.status).toBe(503);
	});
});

describe('completionAccessReissueBodySchema', () => {
	it('requires grantAccess to be the literal true, not a truthy value', () => {
		expect(
			completionAccessReissueBodySchema.safeParse({
				grantAccess: 1,
				expectedDeliveryId: DELIVERY_ID,
				expectedAttempts: 10,
				expectedFailedAt: FAILED_AT,
				expectedErrorCode: ERROR_CODE
			}).success
		).toBe(false);
	});
});
