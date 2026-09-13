import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	CreateEnvelopeResult,
	EnvelopeApplicationPort,
	EnvelopeListPage
} from '$lib/application/envelopes/model';
import type { Envelope } from '$lib/domain/envelope';
import { createEnvelopeHttpHandlers, type EnvelopeApplicationResolver } from './envelopes';
import { createHttpRequestEvent, organizationScopedLocals } from './http-handler-test-support';

const organizationId = '01900000-0000-7000-8000-000000000002';
const envelopeId = '01900000-0000-7000-8000-000000000001';
const envelope: Envelope = {
	id: envelopeId,
	organizationId,
	title: 'Agreement',
	status: 'draft',
	repositoryGeneration: 0,
	repositoryHead: null,
	repositoryArchiveKey: null,
	repositoryArchiveSha256: null,
	sentCommitSha: null,
	fieldGeneration: 0,
	createdAt: '2026-09-11T00:00:00.000Z',
	updatedAt: '2026-09-11T00:00:00.000Z'
};

function locals(state: App.Locals['identityState'] = 'authorized'): App.Locals {
	return organizationScopedLocals(state, organizationId);
}

function event(input: {
	locals?: App.Locals;
	method?: string;
	body?: string;
	headers?: HeadersInit;
	pathname?: string;
	params?: Record<string, string>;
	search?: string;
}): RequestEvent {
	return createHttpRequestEvent({
		pathname: input.pathname ?? '/api/v1/envelopes',
		method: input.method,
		body: input.body,
		headers: input.headers,
		locals: input.locals ?? locals(),
		params: input.params,
		search: input.search
	});
}

function application(): EnvelopeApplicationPort {
	return {
		create: vi.fn(async (): Promise<CreateEnvelopeResult> => ({ outcome: 'created', envelope })),
		get: vi.fn(async (): Promise<Envelope | null> => envelope),
		getDetail: vi.fn(async () => ({
			envelope,
			recipients: [],
			readyAuditEventId: null,
			fields: []
		})),
		list: vi.fn(async (): Promise<EnvelopeListPage> => ({ items: [envelope], nextCursor: null }))
	};
}

async function invoke(handler: RequestHandler, requestEvent: RequestEvent): Promise<Response> {
	return handler(requestEvent);
}

describe('envelope HTTP handlers', () => {
	it('returns an RFC 9457 authentication problem before resolving dependencies', async () => {
		const resolver: EnvelopeApplicationResolver = vi.fn((): EnvelopeApplicationPort | null => null);
		const response: Response = await invoke(
			createEnvelopeHttpHandlers(resolver).list,
			event({ locals: locals('anonymous') })
		);

		expect(response.status).toBe(401);
		expect(response.headers.get('content-type')).toBe('application/problem+json');
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:authentication-required',
			status: 401
		});
		expect(resolver).not.toHaveBeenCalled();
	});

	it('fails closed with 503 when persistence is not wired', async () => {
		const response: Response = await invoke(
			createEnvelopeHttpHandlers((): null => null).list,
			event({})
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:persistence-unavailable',
			status: 503
		});
	});

	it('requires Idempotency-Key for envelope creation', async () => {
		const response: Response = await invoke(
			createEnvelopeHttpHandlers((): EnvelopeApplicationPort => application()).create,
			event({ method: 'POST', body: JSON.stringify({ title: 'Agreement' }) })
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:idempotency-key-required',
			status: 400
		});
	});

	it('rejects tenant scope supplied in the request body', async () => {
		const app: EnvelopeApplicationPort = application();
		const response: Response = await invoke(
			createEnvelopeHttpHandlers((): EnvelopeApplicationPort => app).create,
			event({
				method: 'POST',
				headers: { 'idempotency-key': 'request-1' },
				body: JSON.stringify({ title: 'Agreement', organizationId: 'attacker-organization' })
			})
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:validation-failed',
			status: 400
		});
		expect(app.create).not.toHaveBeenCalled();
	});

	it('rejects request bodies larger than the bounded JSON limit', async () => {
		const app: EnvelopeApplicationPort = application();
		const response: Response = await invoke(
			createEnvelopeHttpHandlers((): EnvelopeApplicationPort => app).create,
			event({
				method: 'POST',
				headers: { 'idempotency-key': 'request-1' },
				body: JSON.stringify({ title: 'x'.repeat(17 * 1024) })
			})
		);

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:request-body-too-large',
			status: 413
		});
		expect(app.create).not.toHaveBeenCalled();
	});

	it('passes only the authenticated organization to create', async () => {
		const app: EnvelopeApplicationPort = application();
		const response: Response = await invoke(
			createEnvelopeHttpHandlers((): EnvelopeApplicationPort => app).create,
			event({
				method: 'POST',
				headers: { 'idempotency-key': 'request-1' },
				body: JSON.stringify({ title: ' Agreement ' })
			})
		);

		expect(response.status).toBe(201);
		expect(app.create).toHaveBeenCalledWith(
			{ id: 'user-1', organizationId, organizationName: 'Workspace', actorType: 'user' },
			{ idempotencyKey: 'request-1', title: 'Agreement' }
		);
		expect(response.headers.get('location')).toBe(`/api/v1/envelopes/${envelopeId}`);
	});

	it('scopes list and get to the authenticated organization', async () => {
		const app: EnvelopeApplicationPort = application();
		const handlers = createEnvelopeHttpHandlers((): EnvelopeApplicationPort => app);
		const listResponse: Response = await invoke(handlers.list, event({ search: '?limit=25' }));
		const getResponse: Response = await invoke(
			handlers.get,
			event({
				pathname: `/api/v1/envelopes/${envelopeId}`,
				params: { envelopeId }
			})
		);

		expect(listResponse.status).toBe(200);
		expect(getResponse.status).toBe(200);
		expect(app.list).toHaveBeenCalledWith(
			{ id: 'user-1', organizationId, organizationName: 'Workspace', actorType: 'user' },
			{ cursor: null, limit: 25 }
		);
		expect(app.getDetail).toHaveBeenCalledWith(
			{ id: 'user-1', organizationId, organizationName: 'Workspace', actorType: 'user' },
			envelopeId
		);
		expect(await getResponse.json()).toEqual({
			envelope,
			recipients: [],
			readyAuditEventId: null,
			fields: []
		});
	});

	it('returns durable recipients, ready audit event, and fields without capability material', async () => {
		const recipients = [
			{
				id: '01900000-0000-7000-8000-000000000011',
				email: 'signer@example.com',
				name: 'Signer',
				role: 'signer' as const,
				locale: 'en' as const,
				routingOrder: 1,
				status: 'pending' as const
			}
		];
		const fields = [
			{
				id: '01900000-0000-7000-8000-000000000012',
				recipientId: recipients[0].id,
				documentPath: 'documents/agreement.md' as const,
				fieldType: 'signature' as const,
				required: true,
				position: 1,
				geometry: { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05 }
			}
		];
		const readyAuditEventId = '01900000-0000-7000-8000-000000000013';
		const app: EnvelopeApplicationPort = {
			...application(),
			getDetail: vi.fn(async () => ({
				envelope: { ...envelope, status: 'ready' as const, repositoryGeneration: 1 },
				recipients,
				readyAuditEventId,
				fields
			}))
		};
		const response: Response = await invoke(
			createEnvelopeHttpHandlers((): EnvelopeApplicationPort => app).get,
			event({
				pathname: `/api/v1/envelopes/${envelopeId}`,
				params: { envelopeId }
			})
		);
		const body = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(200);
		expect(body).toEqual({
			envelope: { ...envelope, status: 'ready', repositoryGeneration: 1 },
			recipients,
			readyAuditEventId,
			fields
		});
		expect(JSON.stringify(body)).not.toContain('capability');
		expect(JSON.stringify(body)).not.toContain('label');
	});
});
