import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	EnvelopeVoidApplicationPort,
	VoidEnvelopeResult
} from '$lib/application/envelopes/void';
import { createEnvelopeVoidHandler, type EnvelopeVoidApplicationResolver } from './envelope-void';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';

const envelopeId: string = '01900000-0000-7000-8000-000000000001';

function locals(state: App.Locals['identityState'] = 'active'): App.Locals {
	return instanceScopedLocals(state);
}

function apiKeyLocals(): App.Locals {
	return {
		apiKeyAuthentication: {
			state: 'authenticated',
			principal: {
				apiKeyId: '01900000-0000-7000-8000-000000000201',
				keyPrefix: 'signkit_abcdefgh',
				ownerUserId: 'user-1',
				scopes: ['envelopes:send'],
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
	body?: string;
	headers?: HeadersInit;
	locals?: App.Locals;
	envelopeId?: string;
}): RequestEvent {
	const id: string = input.envelopeId ?? envelopeId;
	return createHttpRequestEvent({
		pathname: `/api/v1/envelopes/${id}/void`,
		method: 'POST',
		body: input.body,
		headers: input.headers,
		locals: input.locals ?? locals(),
		params: { envelopeId: id },
		jsonBodyContentType: true
	});
}

function validBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ expectedStatus: 'sent', expectedGeneration: 3, ...overrides });
}

function application(result?: VoidEnvelopeResult): EnvelopeVoidApplicationPort {
	return {
		voidEnvelope: vi.fn(
			async (): Promise<VoidEnvelopeResult> =>
				result ?? {
					outcome: 'published',
					result: {
						envelopeId,
						status: 'voided',
						previousStatus: 'sent',
						generation: 3,
						voidedAt: '2026-09-12T01:02:03.000Z',
						revokedCapabilityCount: 2,
						auditEventId: 'void-audit-1'
					}
				}
		)
	};
}

describe('envelope void HTTP handler', () => {
	it('authorizes before parsing or resolving dependencies', async () => {
		const resolver: EnvelopeVoidApplicationResolver = vi.fn(() => null);
		const response: Response = await createEnvelopeVoidHandler(resolver)(
			event({
				locals: locals('anonymous'),
				body: '{',
				headers: { 'idempotency-key': 'void-1' }
			})
		);
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('requires a UUID envelope and a bounded visible-ASCII idempotency key', async () => {
		const handler = createEnvelopeVoidHandler(() => application());
		const invalidId: Response = await handler(
			event({
				envelopeId: 'not-a-uuid',
				body: validBody(),
				headers: { 'idempotency-key': 'void-1' }
			})
		);
		const missingKey: Response = await handler(event({ body: validBody() }));
		const spacedKey: Response = await handler(
			event({ body: validBody(), headers: { 'idempotency-key': 'void key' } })
		);
		const longKey: Response = await handler(
			event({ body: validBody(), headers: { 'idempotency-key': 'x'.repeat(201) } })
		);
		expect(invalidId.status).toBe(400);
		expect(missingKey.status).toBe(400);
		expect(spacedKey.status).toBe(400);
		expect(longKey.status).toBe(400);
	});

	it('requires application/json and a strict body no larger than 4 KiB', async () => {
		const handler = createEnvelopeVoidHandler(() => application());
		const wrongType: Response = await handler(
			event({
				body: validBody(),
				headers: { 'content-type': 'text/plain', 'idempotency-key': 'void-1' }
			})
		);
		const extra: Response = await handler(
			event({
				body: validBody({ extra: true }),
				headers: { 'idempotency-key': 'void-1' }
			})
		);
		const oversized: Response = await handler(
			event({
				body: JSON.stringify({
					expectedStatus: 'sent',
					expectedGeneration: 3,
					pad: 'x'.repeat(4096)
				}),
				headers: { 'idempotency-key': 'void-1' }
			})
		);
		expect(wrongType.status).toBe(415);
		expect(extra.status).toBe(400);
		expect(oversized.status).toBe(413);
	});

	it.each([
		['draft', 0],
		['ready', 1],
		['sent', 2],
		['in_progress', 2_147_483_647]
	] as const)(
		'passes authenticated tenant scope for %s at generation %s',
		async (expectedStatus, expectedGeneration) => {
			const app: EnvelopeVoidApplicationPort = application();
			const response: Response = await createEnvelopeVoidHandler(() => app)(
				event({
					body: validBody({ expectedStatus, expectedGeneration }),
					headers: { 'idempotency-key': 'void-1' }
				})
			);
			expect(response.status).toBe(200);
			expect(app.voidEnvelope).toHaveBeenCalledWith(
				{ id: 'user-1', createdByUserId: 'user-1', actorType: 'user' },
				envelopeId,
				{ idempotencyKey: 'void-1', expectedStatus, expectedGeneration }
			);
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
	);

	it('records an API-key caller as an agent actor', async () => {
		const app: EnvelopeVoidApplicationPort = application();
		const response: Response = await createEnvelopeVoidHandler(() => app)(
			event({
				body: validBody(),
				headers: { 'idempotency-key': 'void-1' },
				locals: apiKeyLocals()
			})
		);
		expect(response.status).toBe(200);
		expect(app.voidEnvelope).toHaveBeenCalledWith(
			{
				id: '01900000-0000-7000-8000-000000000201',
				createdByUserId: 'user-1',
				actorType: 'agent'
			},
			envelopeId,
			{ idempotencyKey: 'void-1', expectedStatus: 'sent', expectedGeneration: 3 }
		);
	});

	it('marks safe replays and returns the public generation', async () => {
		const replayed: VoidEnvelopeResult = {
			outcome: 'replayed',
			result: {
				envelopeId,
				status: 'voided',
				previousStatus: 'sent',
				generation: 3,
				voidedAt: '2026-09-12T01:02:03.000Z',
				revokedCapabilityCount: 2,
				auditEventId: 'void-audit-1'
			}
		};
		const response: Response = await createEnvelopeVoidHandler(() => application(replayed))(
			event({ body: validBody(), headers: { 'idempotency-key': 'void-1' } })
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
		expect(await response.json()).toMatchObject({ voided: { generation: 3 } });
	});

	it.each([
		['idempotency_conflict', 409, 'urn:signkit:problem:void-idempotency-conflict', null],
		['not_found', 404, 'urn:signkit:problem:envelope-not-found', null],
		['not_voidable', 409, 'urn:signkit:problem:envelope-not-voidable', null],
		['status_conflict', 409, 'urn:signkit:problem:envelope-void-status-conflict', null],
		['generation_conflict', 409, 'urn:signkit:problem:envelope-void-generation-conflict', null],
		['audit_conflict', 409, 'urn:signkit:problem:audit-head-conflict', '1'],
		['delivery_in_flight', 409, 'urn:signkit:problem:envelope-void-delivery-in-flight', '1'],
		['integrity_error', 503, 'urn:signkit:problem:void-integrity-error', null]
	] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type, retryAfter) => {
		const response: Response = await createEnvelopeVoidHandler(() => application({ outcome }))(
			event({ body: validBody(), headers: { 'idempotency-key': 'void-1' } })
		);
		expect(response.status).toBe(status);
		expect(response.headers.get('retry-after')).toBe(retryAfter);
		expect(await response.json()).toMatchObject({ type, status });
	});

	it('returns 503 when persistence resolution fails', async () => {
		const response: Response = await createEnvelopeVoidHandler(async () => {
			throw new Error('unavailable');
		})(event({ body: validBody(), headers: { 'idempotency-key': 'void-1' } }));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:persistence-unavailable'
		});
	});
});
