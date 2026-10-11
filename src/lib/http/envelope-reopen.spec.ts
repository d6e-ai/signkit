import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	EnvelopeReopenApplicationPort,
	ReopenEnvelopeResult
} from '$lib/application/envelopes/reopen';
import { InvalidReopenCommandError } from '$lib/application/envelopes/reopen';
import {
	createEnvelopeReopenHandler,
	type EnvelopeReopenApplicationResolver
} from './envelope-reopen';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';

const envelopeId: string = '01900000-0000-7000-8000-000000000001';
const readyAuditEventId: string = '01900000-0000-7000-8000-000000000099';

function locals(state: App.Locals['identityState'] = 'active'): App.Locals {
	return instanceScopedLocals(state);
}

function event(input: { body?: string; headers?: HeadersInit; locals?: App.Locals }): RequestEvent {
	return createHttpRequestEvent({
		pathname: `/api/v1/envelopes/${envelopeId}/reopen`,
		method: 'POST',
		body: input.body,
		headers: input.headers,
		locals: input.locals ?? locals(),
		params: { envelopeId },
		jsonBodyContentType: true
	});
}

function validBody(): string {
	return JSON.stringify({
		expectedGeneration: 2,
		expectedFieldGeneration: 1,
		expectedReadyAuditEventId: readyAuditEventId
	});
}

function application(result?: ReopenEnvelopeResult): EnvelopeReopenApplicationPort {
	return {
		reopen: vi.fn(
			async (): Promise<ReopenEnvelopeResult> =>
				result ?? {
					outcome: 'published',
					result: {
						envelopeId,
						status: 'draft',
						generation: 2,
						fieldGeneration: 2,
						updatedAt: '2026-09-11T00:00:00.000Z',
						auditEventId: '01900000-0000-7000-8000-0000000000aa'
					}
				}
		)
	};
}

describe('envelope reopen HTTP handler', () => {
	it('authorizes drafts:write before parsing or resolving dependencies', async () => {
		const resolver: EnvelopeReopenApplicationResolver = vi.fn(() => null);
		const response: Response = await createEnvelopeReopenHandler(resolver)(
			event({ locals: locals('anonymous'), body: '{', headers: { 'idempotency-key': 'reopen-1' } })
		);
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('requires an idempotency key and a strict JSON body', async () => {
		const missingKey: Response = await createEnvelopeReopenHandler(() => application())(
			event({ body: validBody() })
		);
		expect(missingKey.status).toBe(400);
		expect(await missingKey.json()).toMatchObject({
			type: 'urn:signkit:problem:idempotency-key-required'
		});

		const extra: Response = await createEnvelopeReopenHandler(() => application())(
			event({
				headers: { 'idempotency-key': 'reopen-1' },
				body: JSON.stringify({
					expectedGeneration: 2,
					expectedFieldGeneration: 1,
					expectedReadyAuditEventId: readyAuditEventId,
					extra: true
				})
			})
		);
		expect(extra.status).toBe(400);
	});

	it('returns the reopened receipt with replayed=false on first publication', async () => {
		const response: Response = await createEnvelopeReopenHandler(() => application())(
			event({ headers: { 'idempotency-key': 'reopen-1' }, body: validBody() })
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBeNull();
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			replayed: false,
			reopened: { envelopeId, status: 'draft', generation: 2, fieldGeneration: 2 }
		});
		expect(JSON.stringify(body)).not.toContain('label');
		expect(JSON.stringify(body)).not.toContain('archive');
	});

	it('sets the replay header and replayed=true on a safe replay', async () => {
		const response: Response = await createEnvelopeReopenHandler(() =>
			application({
				outcome: 'replayed',
				result: {
					envelopeId,
					status: 'draft',
					generation: 2,
					fieldGeneration: 2,
					updatedAt: '2026-09-11T00:00:00.000Z',
					auditEventId: '01900000-0000-7000-8000-0000000000aa'
				}
			})
		)(event({ headers: { 'idempotency-key': 'reopen-1' }, body: validBody() }));
		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
		expect(await response.json()).toMatchObject({ replayed: true });
	});

	it('maps not-ready and missing envelopes to existing RFC 9457 types', async () => {
		const notReady: Response = await createEnvelopeReopenHandler(() =>
			application({ outcome: 'not_ready' })
		)(event({ headers: { 'idempotency-key': 'reopen-1' }, body: validBody() }));
		expect(notReady.status).toBe(409);
		expect(await notReady.json()).toMatchObject({
			type: 'urn:signkit:problem:envelope-not-ready'
		});

		const missing: Response = await createEnvelopeReopenHandler(() =>
			application({ outcome: 'not_found' })
		)(event({ headers: { 'idempotency-key': 'reopen-1' }, body: validBody() }));
		expect(missing.status).toBe(404);
	});

	it('maps conflict, integrity, and thrown failures to RFC 9457 statuses', async () => {
		const cases: readonly {
			outcome: ReopenEnvelopeResult['outcome'];
			status: number;
			type: string;
		}[] = [
			{
				outcome: 'idempotency_conflict',
				status: 409,
				type: 'urn:signkit:problem:reopen-idempotency-conflict'
			},
			{
				outcome: 'generation_conflict',
				status: 409,
				type: 'urn:signkit:problem:draft-generation-conflict'
			},
			{
				outcome: 'field_generation_conflict',
				status: 409,
				type: 'urn:signkit:problem:field-generation-conflict'
			},
			{
				outcome: 'audit_conflict',
				status: 409,
				type: 'urn:signkit:problem:audit-head-conflict'
			},
			{
				outcome: 'integrity_error',
				status: 503,
				type: 'urn:signkit:problem:reopen-integrity-error'
			}
		];
		for (const entry of cases) {
			const response: Response = await createEnvelopeReopenHandler(() =>
				application({ outcome: entry.outcome } as ReopenEnvelopeResult)
			)(event({ headers: { 'idempotency-key': 'reopen-1' }, body: validBody() }));
			expect(response.status).toBe(entry.status);
			expect(await response.json()).toMatchObject({ type: entry.type });
		}

		const thrown: Response = await createEnvelopeReopenHandler(() => ({
			reopen: async (): Promise<ReopenEnvelopeResult> => {
				throw new Error('store unavailable');
			}
		}))(event({ headers: { 'idempotency-key': 'reopen-1' }, body: validBody() }));
		expect(thrown.status).toBe(503);
		expect(await thrown.json()).toMatchObject({
			type: 'urn:signkit:problem:service-unavailable'
		});

		const invalid: Response = await createEnvelopeReopenHandler(() => ({
			reopen: async (): Promise<ReopenEnvelopeResult> => {
				throw new InvalidReopenCommandError('Expected generation is outside the supported range');
			}
		}))(event({ headers: { 'idempotency-key': 'reopen-1' }, body: validBody() }));
		expect(invalid.status).toBe(400);
	});
});
