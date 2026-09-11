import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	EnvelopeFieldApplicationPort,
	PlaceFieldsResult
} from '$lib/application/envelopes/fields';
import { InvalidFieldPlacementError } from '$lib/application/envelopes/fields';
import {
	createEnvelopeFieldsHandler,
	type EnvelopeFieldApplicationResolver
} from './envelope-fields';

const organizationId: string = '01900000-0000-7000-8000-000000000002';
const envelopeId: string = '01900000-0000-7000-8000-000000000001';
const recipientId: string = '01900000-0000-7000-8000-000000000003';

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
	const pathname: string = `/api/v1/envelopes/${envelopeId}/fields`;
	const url: URL = new URL(`https://signkit.example${pathname}`);
	const headers: Headers = new Headers(input.headers);
	if (input.body !== undefined && !headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	return {
		locals: input.locals ?? locals(),
		params: { envelopeId },
		url,
		request: new Request(url, { method: 'POST', headers, body: input.body })
	} as RequestEvent;
}

function validBody(): string {
	return JSON.stringify({
		expectedGeneration: 2,
		expectedFieldGeneration: 0,
		fields: [
			{
				recipientId,
				documentPath: 'documents/agreement.md',
				fieldType: 'signature',
				label: 'Sign here',
				required: true,
				position: 1
			}
		]
	});
}

function application(result?: PlaceFieldsResult): EnvelopeFieldApplicationPort {
	return {
		place: vi.fn(
			async (): Promise<PlaceFieldsResult> =>
				result ?? {
					outcome: 'published',
					result: {
						envelopeId,
						generation: 2,
						fieldGeneration: 1,
						commitSha: '0123456789abcdef0123456789abcdef01234567',
						fields: [
							{
								id: 'field-1',
								recipientId,
								documentPath: 'documents/agreement.md',
								fieldType: 'signature',
								required: true,
								position: 1
							}
						],
						updatedAt: '2026-09-11T00:00:00.000Z',
						auditEventId: 'audit-1'
					}
				}
		)
	};
}

describe('envelope fields HTTP handler', () => {
	it('authorizes before parsing or resolving dependencies', async () => {
		const resolver: EnvelopeFieldApplicationResolver = vi.fn(() => null);
		const response: Response = await createEnvelopeFieldsHandler(resolver)(
			event({ locals: locals('anonymous'), body: '{', headers: { 'idempotency-key': 'fields-1' } })
		);
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('requires an idempotency key', async () => {
		const response: Response = await createEnvelopeFieldsHandler(() => application())(
			event({ body: validBody() })
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:idempotency-key-required'
		});
	});

	it('requires an application/json content type', async () => {
		const response: Response = await createEnvelopeFieldsHandler(() => application())(
			event({
				body: validBody(),
				headers: { 'content-type': 'text/plain', 'idempotency-key': 'fields-1' }
			})
		);
		expect(response.status).toBe(415);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:unsupported-media-type'
		});
	});

	it('maps a failing request body stream to invalid JSON', async () => {
		const pathname: string = `/api/v1/envelopes/${envelopeId}/fields`;
		const url: URL = new URL(`https://signkit.example${pathname}`);
		const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			start(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.error(new Error('client disconnected'));
			}
		});
		const request: Request = new Request(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'idempotency-key': 'fields-stream-error'
			},
			body,
			duplex: 'half'
		} as RequestInit & { duplex: 'half' });
		const requestEvent = {
			locals: locals(),
			params: { envelopeId },
			url,
			request
		} as RequestEvent;

		const response: Response = await createEnvelopeFieldsHandler(() => application())(requestEvent);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:invalid-json'
		});
	});

	it('rejects an empty or oversized field list', async () => {
		const handler = createEnvelopeFieldsHandler(() => application());
		const empty: Response = await handler(
			event({
				headers: { 'idempotency-key': 'fields-1' },
				body: JSON.stringify({ expectedGeneration: 1, expectedFieldGeneration: 0, fields: [] })
			})
		);
		expect(empty.status).toBe(400);
	});

	it('rejects repeated recipient/document positions even when field types differ', async () => {
		const handler = createEnvelopeFieldsHandler(() => application());
		const field = {
			recipientId,
			documentPath: 'documents/agreement.md',
			fieldType: 'signature',
			label: 'Sign here',
			required: true,
			position: 1
		};
		const response: Response = await handler(
			event({
				headers: { 'idempotency-key': 'fields-1' },
				body: JSON.stringify({
					expectedGeneration: 1,
					expectedFieldGeneration: 0,
					fields: [field, { ...field, fieldType: 'initials', label: 'Initial here instead' }]
				})
			})
		);
		expect(response.status).toBe(400);
	});

	it('rejects a field generation that cannot be incremented portably', async () => {
		const body = JSON.parse(validBody()) as Record<string, unknown>;
		body.expectedFieldGeneration = 2_147_483_647;
		const response: Response = await createEnvelopeFieldsHandler(() => application())(
			event({
				headers: { 'idempotency-key': 'fields-max' },
				body: JSON.stringify(body)
			})
		);
		expect(response.status).toBe(400);
	});

	it('rejects control characters in field labels before calling the application', async () => {
		const app: EnvelopeFieldApplicationPort = application();
		const body = JSON.parse(validBody()) as {
			fields: Array<{ label: string }>;
		};
		body.fields[0].label = 'Sign\u0007here';
		const response: Response = await createEnvelopeFieldsHandler(() => app)(
			event({
				headers: { 'idempotency-key': 'fields-control-label' },
				body: JSON.stringify(body)
			})
		);
		expect(response.status).toBe(400);
		expect(app.place).not.toHaveBeenCalled();
	});

	it('maps application-level validation failures to 400 instead of 503', async () => {
		const rejectingApplication: EnvelopeFieldApplicationPort = {
			place: vi.fn(async () => {
				throw new InvalidFieldPlacementError('Field label is invalid');
			})
		};
		const response: Response = await createEnvelopeFieldsHandler(() => rejectingApplication)(
			event({
				headers: { 'idempotency-key': 'fields-invalid' },
				body: validBody()
			})
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:validation-failed'
		});
	});

	it('passes only authenticated tenant scope and returns an idempotent receipt', async () => {
		const app: EnvelopeFieldApplicationPort = application();
		const response: Response = await createEnvelopeFieldsHandler(() => app)(
			event({
				headers: { 'idempotency-key': 'fields-1' },
				body: validBody()
			})
		);
		expect(response.status).toBe(200);
		expect(app.place).toHaveBeenCalledWith(
			{ id: 'user-1', organizationId, organizationName: 'Workspace' },
			envelopeId,
			{
				idempotencyKey: 'fields-1',
				expectedGeneration: 2,
				expectedFieldGeneration: 0,
				fields: [
					{
						recipientId,
						documentPath: 'documents/agreement.md',
						fieldType: 'signature',
						label: 'Sign here',
						required: true,
						position: 1
					}
				]
			}
		);
		const payload: unknown = await response.json();
		expect(payload).toMatchObject({ fields: { envelopeId, fieldGeneration: 1 } });
		expect(JSON.stringify(payload)).not.toContain('Sign here');
	});

	it.each([
		['idempotency_conflict', 409, 'urn:signkit:problem:fields-idempotency-conflict'],
		['not_found', 404, 'urn:signkit:problem:envelope-not-found'],
		['not_ready', 409, 'urn:signkit:problem:envelope-not-ready'],
		['generation_conflict', 409, 'urn:signkit:problem:draft-generation-conflict'],
		['field_generation_conflict', 409, 'urn:signkit:problem:field-generation-conflict'],
		['audit_conflict', 409, 'urn:signkit:problem:audit-head-conflict'],
		['invalid_document', 422, 'urn:signkit:problem:field-invalid-document'],
		['invalid_recipient', 422, 'urn:signkit:problem:field-invalid-recipient'],
		['integrity_error', 503, 'urn:signkit:problem:fields-integrity-error']
	] as const)('maps %s to an RFC 9457 problem', async (outcome, status, type) => {
		const response: Response = await createEnvelopeFieldsHandler(() => application({ outcome }))(
			event({ headers: { 'idempotency-key': 'fields-1' }, body: validBody() })
		);
		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ type, status });
	});

	it('marks safe replays without exposing persistence internals or labels', async () => {
		const replay = application({
			outcome: 'replayed',
			result: {
				envelopeId,
				generation: 2,
				fieldGeneration: 1,
				commitSha: '0123456789abcdef0123456789abcdef01234567',
				fields: [
					{
						id: 'field-1',
						recipientId,
						documentPath: 'documents/agreement.md',
						fieldType: 'signature',
						required: true,
						position: 1
					}
				],
				updatedAt: '2026-09-11T00:00:00.000Z',
				auditEventId: 'audit-1'
			}
		});
		const response: Response = await createEnvelopeFieldsHandler(() => replay)(
			event({ headers: { 'idempotency-key': 'fields-1' }, body: validBody() })
		);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
		const text: string = JSON.stringify(await response.json());
		expect(text).not.toContain('Sign here');
		expect(text).not.toContain('archive');
	});
});
