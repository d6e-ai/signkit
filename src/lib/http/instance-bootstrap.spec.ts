import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceApplicationPort } from '$lib/application/instance/instance-service';
import type { InstanceMemberMetadata } from '$lib/ports/instance-store';
import { createInstanceBootstrapHandler, type BootstrapSecretResolver } from './instance-bootstrap';

const VALID_SECRET: string = 'signkit-bootstrap-secret-0123456789abcdef';
const NOW: string = '2026-09-12T12:00:00.000Z';

const mockMember: InstanceMemberMetadata = {
	userId: 'user-1',
	role: 'owner',
	status: 'active',
	createdAt: NOW,
	updatedAt: NOW
};

function locals(state: App.Locals['identityState'] = 'authorized'): App.Locals {
	return {
		apiKeyAuthentication: { state: 'absent' },
		identityState: state,
		memberships: [],
		organizationId: null,
		principal:
			state === 'unavailable' || state === 'anonymous'
				? null
				: { subject: 'user-1', email: 'user@example.com', name: 'User' }
	};
}

function event(input: {
	locals?: App.Locals;
	body?: string;
	headers?: HeadersInit;
	secret?: string | null;
}): { event: RequestEvent; resolveSecret: BootstrapSecretResolver } {
	const pathname: string = '/api/v1/instance/bootstrap';
	const url: URL = new URL(`https://signkit.example${pathname}`);
	const headers: Headers = new Headers(input.headers);
	if (input.body !== undefined && !headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	const requestEvent: RequestEvent = {
		locals: input.locals ?? locals(),
		params: {},
		request: new Request(url, { method: 'POST', headers, body: input.body }),
		url
	} as RequestEvent;

	const resolveSecret: BootstrapSecretResolver = (): string | null =>
		input.secret !== undefined ? input.secret : VALID_SECRET;

	return { event: requestEvent, resolveSecret };
}

describe('POST /api/v1/instance/bootstrap HTTP handler', () => {
	it('checks secret before identity and returns opaque 404 on unset or mismatch', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler(
			(): InstanceApplicationPort => app,
			() => null
		);

		// Unset secret
		const res1 = await handler(
			event({
				secret: null,
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'key-1' },
				body: '{}'
			}).event
		);
		expect(res1.status).toBe(404);
		expect(await res1.json()).toMatchObject({
			type: 'urn:signkit:problem:not-found',
			status: 404
		});

		// Missing authorization header
		const handlerWithSecret = createInstanceBootstrapHandler(
			(): InstanceApplicationPort => app,
			() => VALID_SECRET
		);
		const res2 = await handlerWithSecret(
			event({
				headers: { 'idempotency-key': 'key-1' },
				body: '{}'
			}).event
		);
		expect(res2.status).toBe(404);

		// Mismatched secret
		const res3 = await handlerWithSecret(
			event({
				headers: {
					authorization: 'Bearer wrong-secret-0123456789abcdef01234567',
					'idempotency-key': 'key-1'
				},
				body: '{}'
			}).event
		);
		expect(res3.status).toBe(404);

		// Malformed header (non-Bearer)
		const res4 = await handlerWithSecret(
			event({
				headers: {
					authorization: `Basic ${VALID_SECRET}`,
					'idempotency-key': 'key-1'
				},
				body: '{}'
			}).event
		);
		expect(res4.status).toBe(404);

		// Secret shorter than strict bounds (< 32 chars)
		const res5 = await handlerWithSecret(
			event({
				headers: {
					authorization: 'Bearer short',
					'idempotency-key': 'key-1'
				},
				body: '{}'
			}).event
		);
		expect(res5.status).toBe(404);
		expect(app.bootstrapInstance).not.toHaveBeenCalled();
	});

	it('requires verified identity after secret verification', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler(
			(): InstanceApplicationPort => app,
			() => VALID_SECRET
		);

		// Anonymous caller
		const anonRes = await handler(
			event({
				locals: locals('anonymous'),
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'key-1' },
				body: '{}'
			}).event
		);
		expect(anonRes.status).toBe(401);
		expect(await anonRes.json()).toMatchObject({
			type: 'urn:signkit:problem:authentication-required',
			status: 401
		});

		// Identity unavailable
		const unavailRes = await handler(
			event({
				locals: locals('unavailable'),
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'key-1' },
				body: '{}'
			}).event
		);
		expect(unavailRes.status).toBe(503);
		expect(await unavailRes.json()).toMatchObject({
			type: 'urn:signkit:problem:identity-unavailable',
			status: 503
		});
	});

	it('requires valid visible-ASCII Idempotency-Key header', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler(
			(): InstanceApplicationPort => app,
			() => VALID_SECRET
		);

		// Missing idempotency key
		const missingRes = await handler(
			event({
				headers: { authorization: `Bearer ${VALID_SECRET}` },
				body: '{}'
			}).event
		);
		expect(missingRes.status).toBe(400);
		expect(await missingRes.json()).toMatchObject({
			type: 'urn:signkit:problem:idempotency-key-required',
			status: 400
		});

		// Invalid ASCII in idempotency key
		const invalidRes = await handler(
			event({
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'key with spaces' },
				body: '{}'
			}).event
		);
		expect(invalidRes.status).toBe(400);
	});

	it('requires strict bounded application/json empty object body', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler(
			(): InstanceApplicationPort => app,
			() => VALID_SECRET
		);

		// Non-JSON content-type
		const nonJsonRes = await handler(
			event({
				headers: {
					authorization: `Bearer ${VALID_SECRET}`,
					'idempotency-key': 'key-1',
					'content-type': 'text/plain'
				},
				body: '{}'
			}).event
		);
		expect(nonJsonRes.status).toBe(415);
		expect(await nonJsonRes.json()).toMatchObject({
			type: 'urn:signkit:problem:unsupported-media-type',
			status: 415
		});

		// Invalid JSON
		const invalidJsonRes = await handler(
			event({
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'key-1' },
				body: '{invalid'
			}).event
		);
		expect(invalidJsonRes.status).toBe(400);
		expect(await invalidJsonRes.json()).toMatchObject({
			type: 'urn:signkit:problem:invalid-json',
			status: 400
		});

		// Non-empty object body (extra properties)
		const extraPropRes = await handler(
			event({
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'key-1' },
				body: JSON.stringify({ extra: 'property' })
			}).event
		);
		expect(extraPropRes.status).toBe(400);
		expect(await extraPropRes.json()).toMatchObject({
			type: 'urn:signkit:problem:validation-failed',
			status: 400
		});

		// Array instead of object
		const arrayRes = await handler(
			event({
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'key-1' },
				body: '[]'
			}).event
		);
		expect(arrayRes.status).toBe(400);
	});

	it('maps a failing request body stream to a bounded invalid-json problem', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler(
			(): InstanceApplicationPort => app,
			() => VALID_SECRET
		);

		const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			start(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.error(new Error('client disconnected'));
			}
		});
		const request: Request = new Request('https://signkit.example/api/v1/instance/bootstrap', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${VALID_SECRET}`,
				'idempotency-key': 'key-1',
				'content-type': 'application/json'
			},
			body,
			duplex: 'half'
		} as RequestInit & { duplex: 'half' });
		const requestEvent = {
			locals: locals(),
			params: {},
			url: new URL(request.url),
			request
		} as RequestEvent;

		const response: Response = await handler(requestEvent);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:invalid-json'
		});
		expect(app.bootstrapInstance).not.toHaveBeenCalled();
	});

	it('cancels the request body stream and returns 413 once the bounded limit is exceeded', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler(
			(): InstanceApplicationPort => app,
			() => VALID_SECRET
		);

		let cancelled: boolean = false;
		const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
			},
			cancel(): void {
				cancelled = true;
			}
		});
		const request: Request = new Request('https://signkit.example/api/v1/instance/bootstrap', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${VALID_SECRET}`,
				'idempotency-key': 'key-1',
				'content-type': 'application/json'
			},
			body,
			duplex: 'half'
		} as RequestInit & { duplex: 'half' });
		const requestEvent = {
			locals: locals(),
			params: {},
			url: new URL(request.url),
			request
		} as RequestEvent;

		const response: Response = await handler(requestEvent);
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:request-body-too-large'
		});
		expect(cancelled).toBe(true);
		expect(app.bootstrapInstance).not.toHaveBeenCalled();
	});

	it('returns 201 on first claim with member metadata and no-store headers', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn().mockResolvedValue({
				outcome: 'bootstrapped',
				member: mockMember
			}),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler(
			(): InstanceApplicationPort => app,
			() => VALID_SECRET
		);

		const res = await handler(
			event({
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'key-1' },
				body: '{}'
			}).event
		);

		expect(res.status).toBe(201);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('idempotency-replayed')).toBeNull();
		expect(await res.json()).toEqual({
			member: mockMember,
			bootstrapped: true
		});
	});

	it('returns 200 on safe idempotency replay with idempotency-replayed header', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn().mockResolvedValue({
				outcome: 'already_bootstrapped',
				member: mockMember,
				replayed: true
			}),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler(
			(): InstanceApplicationPort => app,
			() => VALID_SECRET
		);

		const res = await handler(
			event({
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'key-1' },
				body: '{}'
			}).event
		);

		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('idempotency-replayed')).toBe('true');
		expect(await res.json()).toEqual({
			member: mockMember,
			bootstrapped: true
		});
	});

	it('returns 409 conflict problem on conflicting request fingerprint under same idempotency key', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn().mockResolvedValue({
				outcome: 'idempotency_conflict'
			}),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler(
			(): InstanceApplicationPort => app,
			() => VALID_SECRET
		);

		const res = await handler(
			event({
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'key-1' },
				body: '{}'
			}).event
		);

		expect(res.status).toBe(409);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toMatchObject({
			type: 'urn:signkit:problem:instance-bootstrap-idempotency-conflict',
			status: 409
		});
	});

	it('returns 409 conflict problem when instance is already bootstrapped (cross-subject or fresh key)', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn().mockResolvedValue({
				outcome: 'already_bootstrapped',
				replayed: false
			}),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler(
			(): InstanceApplicationPort => app,
			() => VALID_SECRET
		);

		const res = await handler(
			event({
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'fresh-key-2' },
				body: '{}'
			}).event
		);

		expect(res.status).toBe(409);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toMatchObject({
			type: 'urn:signkit:problem:instance-already-bootstrapped',
			status: 409
		});
	});

	it('returns 503 problem when persistence is unavailable', async () => {
		const handler = createInstanceBootstrapHandler(
			(): InstanceApplicationPort | null => null,
			() => VALID_SECRET
		);

		const res = await handler(
			event({
				headers: { authorization: `Bearer ${VALID_SECRET}`, 'idempotency-key': 'key-1' },
				body: '{}'
			}).event
		);

		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({
			type: 'urn:signkit:problem:persistence-unavailable',
			status: 503
		});
	});
});
