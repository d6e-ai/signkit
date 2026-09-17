import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	EnvelopeSendApplicationPort,
	SendEnvelopeResult
} from '$lib/application/envelopes/send';
import { createEnvelopeSendHandler, type EnvelopeSendApplicationResolver } from './envelope-send';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';

const envelopeId: string = '01900000-0000-7000-8000-000000000001';
const readyAuditEventId: string = '01900000-0000-7000-8000-000000000099';

function locals(state: App.Locals['identityState'] = 'active'): App.Locals {
	return instanceScopedLocals(state);
}
function event(input: { body?: string; headers?: HeadersInit; locals?: App.Locals }): RequestEvent {
	return createHttpRequestEvent({
		pathname: `/api/v1/envelopes/${envelopeId}/send`,
		method: 'POST',
		body: input.body,
		headers: input.headers,
		locals: input.locals ?? locals(),
		params: { envelopeId },
		jsonBodyContentType: true
	});
}
function body(): string {
	return JSON.stringify({ expectedGeneration: 2, expectedReadyAuditEventId: readyAuditEventId });
}
function application(result?: SendEnvelopeResult): EnvelopeSendApplicationPort {
	return {
		send: vi.fn(
			async (): Promise<SendEnvelopeResult> =>
				result ?? {
					outcome: 'published',
					result: {
						envelopeId,
						status: 'sent',
						generation: 2,
						commitSha: 'commit-2',
						readyAuditEventId,
						queuedDeliveryCount: 1,
						reservedCapabilityCount: 2,
						initialCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
						updatedAt: '2026-09-11T00:00:00.000Z',
						auditEventId: 'audit-3'
					}
				}
		)
	};
}

describe('envelope send HTTP handler', () => {
	it('authorizes before parsing or resolving dependencies', async () => {
		const resolver: EnvelopeSendApplicationResolver = vi.fn(() => null);
		const response: Response = await createEnvelopeSendHandler(resolver)(
			event({ locals: locals('anonymous'), body: '{', headers: { 'idempotency-key': 'send-1' } })
		);
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});
	it('passes only authenticated scope and returns a secret-free 202 receipt', async () => {
		const app: EnvelopeSendApplicationPort = application();
		const response: Response = await createEnvelopeSendHandler(() => app)(
			event({ body: body(), headers: { 'idempotency-key': 'send-1' } })
		);
		expect(response.status).toBe(202);
		expect(app.send).toHaveBeenCalledWith(
			{ id: 'user-1', createdByUserId: 'user-1', actorType: 'user' },
			envelopeId,
			{
				idempotencyKey: 'send-1',
				expectedGeneration: 2,
				expectedReadyAuditEventId: readyAuditEventId
			}
		);
		const text: string = await response.text();
		expect(JSON.parse(text)).toMatchObject({
			sent: { envelopeId, status: 'sent', queuedDeliveryCount: 1 }
		});
		expect(text).not.toMatch(/capabilityHash|sealedCapability|skr1_|deliveryId/);
	});
	it.each([
		['idempotency_conflict', 409, 'urn:signkit:problem:send-idempotency-conflict'],
		['not_found', 404, 'urn:signkit:problem:envelope-not-found'],
		['not_ready', 409, 'urn:signkit:problem:envelope-not-ready'],
		['generation_conflict', 409, 'urn:signkit:problem:draft-generation-conflict'],
		['audit_conflict', 409, 'urn:signkit:problem:audit-head-conflict'],
		['integrity_error', 503, 'urn:signkit:problem:send-integrity-error']
	] as const)('maps %s to a problem', async (outcome, status, type) => {
		const response: Response = await createEnvelopeSendHandler(() => application({ outcome }))(
			event({ body: body(), headers: { 'idempotency-key': 'send-1' } })
		);
		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ type, status });
	});
	it('marks idempotent replay', async () => {
		const published = application();
		const result: SendEnvelopeResult = await published.send(
			{ id: 'x', createdByUserId: 'x' },
			envelopeId,
			{ idempotencyKey: 'x', expectedGeneration: 2, expectedReadyAuditEventId: readyAuditEventId }
		);
		if (result.outcome !== 'published') throw new Error('fixture failed');
		const response: Response = await createEnvelopeSendHandler(() =>
			application({ outcome: 'replayed', result: result.result })
		)(event({ body: body(), headers: { 'idempotency-key': 'send-1' } }));
		expect(response.headers.get('idempotency-replayed')).toBe('true');
	});
});
