import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	RecipientCapabilityReissueApplicationPort,
	ReissueRecipientCapabilityResult
} from '$lib/application/signing/recipient-capability-reissue';
import type { PublishedReissueResult } from '$lib/ports/recipient-capability-reissue-store';
import {
	createEnvelopeReissueHandler,
	type EnvelopeReissueApplicationResolver
} from './envelope-reissue';
import { createHttpRequestEvent, organizationScopedLocals } from './http-handler-test-support';

const organizationId: string = '01900000-0000-7000-8000-000000000002';
const envelopeId: string = '01900000-0000-7000-8000-000000000001';
const recipientId: string = '01900000-0000-7000-8000-000000000003';

function locals(state: App.Locals['identityState'] = 'authorized'): App.Locals {
	return organizationScopedLocals(state, organizationId);
}

function event(input: {
	body?: string;
	headers?: HeadersInit;
	locals?: App.Locals;
	envelopeId?: string;
	recipientId?: string;
	pathname?: string;
}): RequestEvent {
	const envId: string = input.envelopeId ?? envelopeId;
	const recId: string | undefined = input.recipientId;
	const pathname =
		input.pathname ??
		(recId
			? `/api/v1/envelopes/${envId}/recipients/${recId}/reissue`
			: `/api/v1/envelopes/${envId}/reissue`);
	return createHttpRequestEvent({
		pathname,
		method: 'POST',
		body: input.body,
		headers: input.headers,
		locals: input.locals ?? locals(),
		params: { envelopeId: envId, ...(recId ? { recipientId: recId } : {}) },
		jsonBodyContentType: true
	});
}

function publishedResult(overrides: Partial<PublishedReissueResult> = {}): PublishedReissueResult {
	return {
		envelopeId,
		recipientId,
		newCapabilityHash: 'd'.repeat(64),
		outboxId: '01900000-0000-7000-8000-000000000099',
		reissuedAt: '2026-09-13T12:00:00.000Z',
		auditEventId: '01900000-0000-7000-8000-000000000088',
		...overrides
	};
}

function application(
	result?: ReissueRecipientCapabilityResult
): RecipientCapabilityReissueApplicationPort {
	return {
		reissue: vi.fn(
			async (): Promise<ReissueRecipientCapabilityResult> =>
				result ?? {
					outcome: 'published',
					result: publishedResult()
				}
		)
	};
}

describe('envelope reissue HTTP handler', () => {
	it('authorizes before parsing or resolving dependencies', async () => {
		const resolver: EnvelopeReissueApplicationResolver = vi.fn(() => null);
		const response: Response = await createEnvelopeReissueHandler(resolver)(
			event({
				locals: locals('anonymous'),
				body: '{',
				headers: { 'idempotency-key': 'reissue-1' },
				recipientId
			})
		);
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('refuses an authenticated API key because reissue is session-only', async () => {
		const resolver: EnvelopeReissueApplicationResolver = vi.fn(() => null);
		const response: Response = await createEnvelopeReissueHandler(resolver)(
			event({
				locals: {
					...locals(),
					apiKeyAuthentication: {
						state: 'authenticated',
						principal: {
							apiKeyId: recipientId,
							keyPrefix: 'signkit_abcdefgh',
							ownerUserId: 'user-1',
							organizationId,
							organizationName: 'Workspace',
							scopes: ['envelopes:send', 'drafts:write', 'envelopes:read'],
							expiresAt: '2026-12-11T00:00:00.000Z'
						}
					}
				},
				body: JSON.stringify({}),
				headers: { 'idempotency-key': 'reissue-1' },
				recipientId
			})
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:api-key-not-permitted'
		});
		expect(resolver).not.toHaveBeenCalled();
	});

	it('requires a UUID envelope and visible-ASCII idempotency key', async () => {
		const handler = createEnvelopeReissueHandler(() => application());
		const invalidEnv: Response = await handler(
			event({
				envelopeId: 'bad-envelope-id',
				recipientId,
				body: JSON.stringify({}),
				headers: { 'idempotency-key': 'reissue-1' }
			})
		);
		expect(invalidEnv.status).toBe(400);

		const missingIdemp: Response = await handler(
			event({
				envelopeId,
				recipientId,
				body: JSON.stringify({})
			})
		);
		expect(missingIdemp.status).toBe(400);
	});

	it('validates recipientId from params or request body', async () => {
		const handler = createEnvelopeReissueHandler(() => application());

		// Missing recipientId entirely
		const missingRec: Response = await handler(
			event({
				envelopeId,
				pathname: `/api/v1/envelopes/${envelopeId}/reissue`,
				body: JSON.stringify({ reason: 'testing' }),
				headers: { 'idempotency-key': 'reissue-1' }
			})
		);
		expect(missingRec.status).toBe(400);

		// Invalid recipientId in body
		const badRec: Response = await handler(
			event({
				envelopeId,
				pathname: `/api/v1/envelopes/${envelopeId}/reissue`,
				body: JSON.stringify({ recipientId: 'bad-id' }),
				headers: { 'idempotency-key': 'reissue-1' }
			})
		);
		expect(badRec.status).toBe(400);
	});

	it('returns 200 with reissued payload and emits NO set-cookie header', async () => {
		const app = application();
		const handler = createEnvelopeReissueHandler(() => app);

		const response: Response = await handler(
			event({
				envelopeId,
				recipientId,
				body: JSON.stringify({ reason: 'resent' }),
				headers: { 'idempotency-key': 'reissue-1' }
			})
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('set-cookie')).toBeNull();
		const json = (await response.json()) as {
			reissued: { envelopeId: string; recipientId: string };
		};
		expect(json.reissued.envelopeId).toBe(envelopeId);
		expect(json.reissued.recipientId).toBe(recipientId);
		expect(app.reissue).toHaveBeenCalledOnce();
	});

	it('sets idempotency-replayed header on replay', async () => {
		const app = application({
			outcome: 'replayed',
			result: publishedResult({ reissuedAt: '2026-09-12T10:00:00.000Z' })
		});
		const handler = createEnvelopeReissueHandler(() => app);

		const response: Response = await handler(
			event({
				envelopeId,
				recipientId,
				body: JSON.stringify({}),
				headers: { 'idempotency-key': 'reissue-1' }
			})
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
		expect(response.headers.get('set-cookie')).toBeNull();
	});

	it('maps domain outcomes to problem responses', async () => {
		const notFoundHandler = createEnvelopeReissueHandler(() =>
			application({ outcome: 'not_found' })
		);
		const notFoundRes = await notFoundHandler(
			event({ envelopeId, recipientId, body: '{}', headers: { 'idempotency-key': 'reissue-1' } })
		);
		expect(notFoundRes.status).toBe(404);

		const notEligibleHandler = createEnvelopeReissueHandler(() =>
			application({ outcome: 'not_eligible', reason: 'recipient_terminal' })
		);
		const notEligibleRes = await notEligibleHandler(
			event({ envelopeId, recipientId, body: '{}', headers: { 'idempotency-key': 'reissue-1' } })
		);
		expect(notEligibleRes.status).toBe(409);

		const inFlightHandler = createEnvelopeReissueHandler(() =>
			application({ outcome: 'delivery_in_flight' })
		);
		const inFlightRes = await inFlightHandler(
			event({ envelopeId, recipientId, body: '{}', headers: { 'idempotency-key': 'reissue-1' } })
		);
		expect(inFlightRes.status).toBe(409);
		expect(inFlightRes.headers.get('retry-after')).toBe('5');

		const idempConflictHandler = createEnvelopeReissueHandler(() =>
			application({ outcome: 'idempotency_conflict' })
		);
		const idempConflictRes = await idempConflictHandler(
			event({ envelopeId, recipientId, body: '{}', headers: { 'idempotency-key': 'reissue-1' } })
		);
		expect(idempConflictRes.status).toBe(409);

		const auditConflictHandler = createEnvelopeReissueHandler(() =>
			application({ outcome: 'audit_conflict' })
		);
		const auditConflictRes = await auditConflictHandler(
			event({ envelopeId, recipientId, body: '{}', headers: { 'idempotency-key': 'reissue-1' } })
		);
		expect(auditConflictRes.status).toBe(409);
		expect(auditConflictRes.headers.get('retry-after')).toBe('1');
	});
});
