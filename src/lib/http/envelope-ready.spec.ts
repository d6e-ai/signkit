import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	EnvelopeReadyApplicationPort,
	ReadyEnvelopeResult
} from '$lib/application/envelopes/ready';
import {
	createEnvelopeReadyHandler,
	type EnvelopeReadyApplicationResolver
} from './envelope-ready';

const organizationId: string = '01900000-0000-7000-8000-000000000002';
const envelopeId: string = '01900000-0000-7000-8000-000000000001';

function locals(state: App.Locals['identityState'] = 'authorized'): App.Locals {
	return {
		identityState: state,
		memberships:
			state === 'authorized'
				? [
						{
							joinedAt: '2026-09-11T00:00:00.000Z',
							role: 'owner',
							organization: {
								id: organizationId,
								name: 'Workspace',
								slug: 'workspace',
								status: 'active'
							}
						}
					]
				: [],
		organizationId: state === 'authorized' ? organizationId : null,
		principal:
			state === 'authorized' ? { subject: 'user-1', email: 'user@example.com', name: 'User' } : null
	};
}

function event(input: { body?: string; headers?: HeadersInit; locals?: App.Locals }): RequestEvent {
	const pathname: string = `/api/v1/envelopes/${envelopeId}/ready`;
	const url: URL = new URL(`https://signkit.example${pathname}`);
	return {
		locals: input.locals ?? locals(),
		params: { envelopeId },
		url,
		request: new Request(url, { method: 'POST', headers: input.headers, body: input.body })
	} as RequestEvent;
}

function validBody(): string {
	return JSON.stringify({
		expectedGeneration: 1,
		recipients: [
			{ email: 'Alice@Example.com', name: 'Alice', role: 'signer', locale: 'ja', routingOrder: 1 }
		]
	});
}

function application(result?: ReadyEnvelopeResult): EnvelopeReadyApplicationPort {
	return {
		ready: vi.fn(
			async (): Promise<ReadyEnvelopeResult> =>
				result ?? {
					outcome: 'published',
					result: {
						envelopeId,
						status: 'ready',
						generation: 1,
						commitSha: '0123456789abcdef0123456789abcdef01234567',
						recipients: [],
						updatedAt: '2026-09-11T00:00:00.000Z',
						auditEventId: 'audit-1'
					}
				}
		)
	};
}

describe('envelope ready HTTP handler', () => {
	it('authorizes before parsing or resolving dependencies', async () => {
		const resolver: EnvelopeReadyApplicationResolver = vi.fn(() => null);
		const response: Response = await createEnvelopeReadyHandler(resolver)(
			event({ locals: locals('anonymous'), body: '{', headers: { 'idempotency-key': 'ready-1' } })
		);
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('requires an idempotency key', async () => {
		const response: Response = await createEnvelopeReadyHandler(() => application())(
			event({ body: validBody() })
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:idempotency-key-required'
		});
	});

	it('rejects duplicate normalized emails and recipient graphs without an actor', async () => {
		const handler = createEnvelopeReadyHandler(() => application());
		const duplicate: Response = await handler(
			event({
				headers: { 'idempotency-key': 'ready-1' },
				body: JSON.stringify({
					expectedGeneration: 1,
					recipients: [
						{ email: 'a@example.com', name: 'A', role: 'signer', locale: 'en', routingOrder: 1 },
						{ email: 'A@example.com', name: 'B', role: 'viewer', locale: 'en', routingOrder: 2 }
					]
				})
			})
		);
		const passive: Response = await handler(
			event({
				headers: { 'idempotency-key': 'ready-2' },
				body: JSON.stringify({
					expectedGeneration: 1,
					recipients: [
						{ email: 'a@example.com', name: 'A', role: 'viewer', locale: 'en', routingOrder: 1 }
					]
				})
			})
		);
		expect(duplicate.status).toBe(400);
		expect(passive.status).toBe(400);
	});

	it('passes only authenticated tenant scope and returns an idempotent receipt', async () => {
		const app: EnvelopeReadyApplicationPort = application();
		const response: Response = await createEnvelopeReadyHandler(() => app)(
			event({
				headers: { 'idempotency-key': 'ready-1' },
				body: validBody()
			})
		);
		expect(response.status).toBe(200);
		expect(app.ready).toHaveBeenCalledWith(
			{ id: 'user-1', organizationId, organizationName: 'Workspace' },
			envelopeId,
			{
				idempotencyKey: 'ready-1',
				expectedGeneration: 1,
				recipients: [
					{
						email: 'Alice@Example.com',
						name: 'Alice',
						role: 'signer',
						locale: 'ja',
						routingOrder: 1
					}
				]
			}
		);
		expect(await response.json()).toMatchObject({ ready: { envelopeId, status: 'ready' } });
	});

	it.each([
		['idempotency_conflict', 409, 'urn:signkit:problem:ready-idempotency-conflict'],
		['not_found', 404, 'urn:signkit:problem:envelope-not-found'],
		['immutable', 409, 'urn:signkit:problem:envelope-not-draft'],
		['generation_conflict', 409, 'urn:signkit:problem:draft-generation-conflict'],
		['audit_conflict', 409, 'urn:signkit:problem:audit-head-conflict'],
		['empty_draft', 409, 'urn:signkit:problem:empty-draft'],
		['integrity_error', 503, 'urn:signkit:problem:ready-integrity-error']
	] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type) => {
		const response: Response = await createEnvelopeReadyHandler(() => application({ outcome }))(
			event({ headers: { 'idempotency-key': 'ready-1' }, body: validBody() })
		);
		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ type, status });
	});

	it('marks safe replays without exposing persistence internals', async () => {
		const replay = application({
			outcome: 'replayed',
			result: {
				envelopeId,
				status: 'ready',
				generation: 1,
				commitSha: '0123456789abcdef0123456789abcdef01234567',
				recipients: [],
				updatedAt: '2026-09-11T00:00:00.000Z',
				auditEventId: 'audit-1'
			}
		});
		const response: Response = await createEnvelopeReadyHandler(() => replay)(
			event({ headers: { 'idempotency-key': 'ready-1' }, body: validBody() })
		);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
		expect(JSON.stringify(await response.json())).not.toContain('archive');
	});
});
