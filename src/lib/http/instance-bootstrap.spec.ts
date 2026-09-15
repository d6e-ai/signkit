import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceApplicationPort } from '$lib/application/instance/instance-service';
import type { InstanceMemberMetadata } from '$lib/ports/instance-store';
import { identityOnlyLocals } from './http-handler-test-support';
import {
	createInstanceBootstrapHandler,
	resolveBootstrapOwnerEmail,
	resolveBootstrapUnsafeContext
} from './instance-bootstrap';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

const NOW: string = '2026-09-12T12:00:00.000Z';

const mockMember: InstanceMemberMetadata = {
	userId: 'user-1',
	role: 'owner',
	status: 'active',
	createdAt: NOW,
	updatedAt: NOW
};

/** Claiming ownership additionally requires a verified email, like instance invitation acceptance. */
function locals(state: App.Locals['identityState'] = 'authorized'): App.Locals {
	return identityOnlyLocals(state, { emailVerified: true });
}

function identityOnlyLocalsWithEmail(email: string): App.Locals {
	return identityOnlyLocals('authorized', { emailVerified: true, email });
}

function event(input: { locals?: App.Locals; body?: string; headers?: HeadersInit }): RequestEvent {
	const pathname: string = '/api/v1/instance/bootstrap';
	const url: URL = new URL(`https://signkit.example${pathname}`);
	const headers: Headers = new Headers(input.headers);
	if (input.body !== undefined && !headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	return {
		locals: input.locals ?? locals(),
		params: {},
		request: new Request(url, { method: 'POST', headers, body: input.body }),
		url
	} as RequestEvent;
}

describe('POST /api/v1/instance/bootstrap HTTP handler', () => {
	beforeEach(() => {
		// Default test environment is local development (unsafe opt-in plus a
		// loopback origin), so the pre-existing store-interaction cases below
		// keep exercising post-gate behavior. Gate-specific cases inject
		// explicit resolvers instead of relying on this default.
		privateEnv.SIGNKIT_ALLOW_UNSAFE_FIRST_USER_BOOTSTRAP = 'true';
		privateEnv.SIGNKIT_PUBLIC_ORIGIN = 'http://localhost:5173';
		delete privateEnv.SIGNKIT_BOOTSTRAP_OWNER_EMAIL;
		delete privateEnv.VERCEL;
	});

	afterEach(() => {
		for (const key of Object.keys(privateEnv)) delete privateEnv[key];
	});
	it('is cookie-session-only: a presented signkit_ API key is rejected, never resolved', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler((): InstanceApplicationPort => app);

		const res = await handler(
			event({
				locals: { ...locals(), apiKeyAuthentication: { state: 'rejected_surface' } },
				headers: { 'idempotency-key': 'key-1' },
				body: '{}'
			})
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({
			type: 'urn:signkit:problem:api-key-not-permitted',
			status: 403
		});
		expect(app.bootstrapInstance).not.toHaveBeenCalled();
	});

	it('requires verified identity', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler((): InstanceApplicationPort => app);

		// Anonymous caller
		const anonRes = await handler(
			event({
				locals: locals('anonymous'),
				headers: { 'idempotency-key': 'key-1' },
				body: '{}'
			})
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
				headers: { 'idempotency-key': 'key-1' },
				body: '{}'
			})
		);
		expect(unavailRes.status).toBe(503);
		expect(await unavailRes.json()).toMatchObject({
			type: 'urn:signkit:problem:identity-unavailable',
			status: 503
		});
	});

	it.each([
		['missing', undefined],
		['false', false]
	] as const)(
		'fails closed when the authenticated emailVerified claim is %s',
		async (_name, emailVerified) => {
			const app: InstanceApplicationPort = {
				bootstrapInstance: vi.fn(),
				getCurrentMember: vi.fn()
			};
			const handler = createInstanceBootstrapHandler((): InstanceApplicationPort => app);

			const res = await handler(
				event({
					locals: identityOnlyLocals(
						'authorized',
						emailVerified === undefined ? {} : { emailVerified }
					),
					headers: { 'idempotency-key': 'key-1' },
					body: '{}'
				})
			);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				type: 'urn:signkit:problem:email-verification-required',
				status: 403
			});
			expect(app.bootstrapInstance).not.toHaveBeenCalled();
		}
	);

	it('requires valid visible-ASCII Idempotency-Key header', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler((): InstanceApplicationPort => app);

		// Missing idempotency key
		const missingRes = await handler(event({ body: '{}' }));
		expect(missingRes.status).toBe(400);
		expect(await missingRes.json()).toMatchObject({
			type: 'urn:signkit:problem:idempotency-key-required',
			status: 400
		});

		// Invalid ASCII in idempotency key
		const invalidRes = await handler(
			event({
				headers: { 'idempotency-key': 'key with spaces' },
				body: '{}'
			})
		);
		expect(invalidRes.status).toBe(400);
	});

	it('requires strict bounded application/json empty object body', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler((): InstanceApplicationPort => app);

		// Non-JSON content-type
		const nonJsonRes = await handler(
			event({
				headers: { 'idempotency-key': 'key-1', 'content-type': 'text/plain' },
				body: '{}'
			})
		);
		expect(nonJsonRes.status).toBe(415);
		expect(await nonJsonRes.json()).toMatchObject({
			type: 'urn:signkit:problem:unsupported-media-type',
			status: 415
		});

		// Invalid JSON
		const invalidJsonRes = await handler(
			event({
				headers: { 'idempotency-key': 'key-1' },
				body: '{invalid'
			})
		);
		expect(invalidJsonRes.status).toBe(400);
		expect(await invalidJsonRes.json()).toMatchObject({
			type: 'urn:signkit:problem:invalid-json',
			status: 400
		});

		// Non-empty object body (extra properties)
		const extraPropRes = await handler(
			event({
				headers: { 'idempotency-key': 'key-1' },
				body: JSON.stringify({ extra: 'property' })
			})
		);
		expect(extraPropRes.status).toBe(400);
		expect(await extraPropRes.json()).toMatchObject({
			type: 'urn:signkit:problem:validation-failed',
			status: 400
		});

		// Array instead of object
		const arrayRes = await handler(
			event({
				headers: { 'idempotency-key': 'key-1' },
				body: '[]'
			})
		);
		expect(arrayRes.status).toBe(400);
	});

	it('maps a failing request body stream to a bounded invalid-json problem', async () => {
		const app: InstanceApplicationPort = {
			bootstrapInstance: vi.fn(),
			getCurrentMember: vi.fn()
		};
		const handler = createInstanceBootstrapHandler((): InstanceApplicationPort => app);

		const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			start(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.error(new Error('client disconnected'));
			}
		});
		const request: Request = new Request('https://signkit.example/api/v1/instance/bootstrap', {
			method: 'POST',
			headers: { 'idempotency-key': 'key-1', 'content-type': 'application/json' },
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
		const handler = createInstanceBootstrapHandler((): InstanceApplicationPort => app);

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
			headers: { 'idempotency-key': 'key-1', 'content-type': 'application/json' },
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
		const handler = createInstanceBootstrapHandler((): InstanceApplicationPort => app);

		const res = await handler(event({ headers: { 'idempotency-key': 'key-1' }, body: '{}' }));

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
		const handler = createInstanceBootstrapHandler((): InstanceApplicationPort => app);

		const res = await handler(event({ headers: { 'idempotency-key': 'key-1' }, body: '{}' }));

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
		const handler = createInstanceBootstrapHandler((): InstanceApplicationPort => app);

		const res = await handler(event({ headers: { 'idempotency-key': 'key-1' }, body: '{}' }));

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
		const handler = createInstanceBootstrapHandler((): InstanceApplicationPort => app);

		const res = await handler(event({ headers: { 'idempotency-key': 'fresh-key-2' }, body: '{}' }));

		expect(res.status).toBe(409);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toMatchObject({
			type: 'urn:signkit:problem:instance-already-bootstrapped',
			status: 409
		});
	});

	it('returns 503 problem when persistence is unavailable', async () => {
		const handler = createInstanceBootstrapHandler((): InstanceApplicationPort | null => null);

		const res = await handler(event({ headers: { 'idempotency-key': 'key-1' }, body: '{}' }));

		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({
			type: 'urn:signkit:problem:persistence-unavailable',
			status: 503
		});
	});

	describe('deploy-time bootstrap owner protection', () => {
		it('refuses a caller whose verified email does not match the configured owner, without consulting the store', async () => {
			const app: InstanceApplicationPort = {
				bootstrapInstance: vi.fn(),
				getCurrentMember: vi.fn()
			};
			const handler = createInstanceBootstrapHandler(
				(): InstanceApplicationPort => app,
				(): string | undefined => 'owner@example.com'
			);

			const res = await handler(
				event({
					locals: identityOnlyLocalsWithEmail('someone-else@example.com'),
					headers: { 'idempotency-key': 'key-1' },
					body: '{}'
				})
			);

			expect(res.status).toBe(403);
			const problem = await res.json();
			expect(problem).toMatchObject({
				type: 'urn:signkit:problem:bootstrap-owner-mismatch',
				status: 403
			});
			// The configured owner email must never be echoed back to a mismatched caller.
			expect(JSON.stringify(problem)).not.toContain('owner@example.com');
			expect(app.bootstrapInstance).not.toHaveBeenCalled();
		});

		it('is case-insensitive and allows a caller whose verified email matches the configured owner', async () => {
			const app: InstanceApplicationPort = {
				bootstrapInstance: vi.fn().mockResolvedValue({
					outcome: 'bootstrapped',
					member: mockMember
				}),
				getCurrentMember: vi.fn()
			};
			const handler = createInstanceBootstrapHandler(
				(): InstanceApplicationPort => app,
				(): string | undefined => 'Owner@Example.com'
			);

			const res = await handler(
				event({
					locals: identityOnlyLocalsWithEmail('owner@example.com'),
					headers: { 'idempotency-key': 'key-1' },
					body: '{}'
				})
			);

			expect(res.status).toBe(201);
			expect(app.bootstrapInstance).toHaveBeenCalledTimes(1);
		});

		it('fails closed when no owner email is configured (no first-user-wins)', async () => {
			const app: InstanceApplicationPort = {
				bootstrapInstance: vi.fn(),
				getCurrentMember: vi.fn()
			};
			const handler = createInstanceBootstrapHandler(
				(): InstanceApplicationPort => app,
				(): string | undefined => undefined,
				() => ({ unsafeOptIn: false, localDevelopment: false })
			);

			const res = await handler(
				event({
					locals: identityOnlyLocalsWithEmail('anybody@example.com'),
					headers: { 'idempotency-key': 'key-1' },
					body: '{}'
				})
			);

			expect(res.status).toBe(403);
			const problem = await res.json();
			expect(problem).toMatchObject({
				type: 'urn:signkit:problem:bootstrap-owner-required',
				status: 403
			});
			expect(app.bootstrapInstance).not.toHaveBeenCalled();
		});

		it('allows first-user bootstrap only under the local-development unsafe opt-in', async () => {
			const app: InstanceApplicationPort = {
				bootstrapInstance: vi.fn().mockResolvedValue({
					outcome: 'bootstrapped',
					member: mockMember
				}),
				getCurrentMember: vi.fn()
			};
			const handler = createInstanceBootstrapHandler(
				(): InstanceApplicationPort => app,
				(): string | undefined => undefined,
				() => ({ unsafeOptIn: true, localDevelopment: true })
			);

			const res = await handler(
				event({
					locals: identityOnlyLocalsWithEmail('dev@example.com'),
					headers: { 'idempotency-key': 'key-1' },
					body: '{}'
				})
			);

			expect(res.status).toBe(201);
			expect(app.bootstrapInstance).toHaveBeenCalledTimes(1);
		});

		it('ignores the unsafe opt-in outside local development and never exposes the expected email', async () => {
			const app: InstanceApplicationPort = {
				bootstrapInstance: vi.fn(),
				getCurrentMember: vi.fn()
			};
			const handler = createInstanceBootstrapHandler(
				(): InstanceApplicationPort => app,
				(): string | undefined => undefined,
				() => ({ unsafeOptIn: true, localDevelopment: false })
			);

			const res = await handler(
				event({
					locals: identityOnlyLocalsWithEmail('stranger@example.com'),
					headers: { 'idempotency-key': 'key-1' },
					body: '{}'
				})
			);

			expect(res.status).toBe(403);
			const problem = await res.json();
			expect(problem).toMatchObject({
				type: 'urn:signkit:problem:bootstrap-owner-required',
				status: 403
			});
			expect(JSON.stringify(problem)).not.toContain('stranger@example.com');
			expect(app.bootstrapInstance).not.toHaveBeenCalled();
		});

		it('lets the real owner still claim after a mismatched attempt (the gate never burns the single claim window)', async () => {
			const app: InstanceApplicationPort = {
				bootstrapInstance: vi.fn().mockResolvedValue({
					outcome: 'bootstrapped',
					member: mockMember
				}),
				getCurrentMember: vi.fn()
			};
			const handler = createInstanceBootstrapHandler(
				(): InstanceApplicationPort => app,
				(): string | undefined => 'owner@example.com'
			);

			const rejected = await handler(
				event({
					locals: identityOnlyLocalsWithEmail('intruder@example.com'),
					headers: { 'idempotency-key': 'key-1' },
					body: '{}'
				})
			);
			expect(rejected.status).toBe(403);
			expect(app.bootstrapInstance).not.toHaveBeenCalled();

			const accepted = await handler(
				event({
					locals: identityOnlyLocalsWithEmail('owner@example.com'),
					headers: { 'idempotency-key': 'key-2' },
					body: '{}'
				})
			);
			expect(accepted.status).toBe(201);
			expect(app.bootstrapInstance).toHaveBeenCalledTimes(1);
		});
	});

	describe('bootstrap env resolvers (Cloudflare platform env vs Node process env)', () => {
		const OWNER = 'SIGNKIT_BOOTSTRAP_OWNER_EMAIL';
		const UNSAFE = 'SIGNKIT_ALLOW_UNSAFE_FIRST_USER_BOOTSTRAP';
		const ORIGIN = 'SIGNKIT_PUBLIC_ORIGIN';
		const VERCEL = 'VERCEL';

		it('reads the owner email from the Cloudflare platform env first', () => {
			privateEnv[OWNER] = 'node@example.com';
			const platform = { env: { SIGNKIT_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com' } };
			expect(resolveBootstrapOwnerEmail(platform as App.Platform)).toBe('owner@example.com');
		});

		it('falls back to the Node process env and treats blank as unconfigured', () => {
			privateEnv[OWNER] = 'node@example.com';
			expect(resolveBootstrapOwnerEmail(undefined)).toBe('node@example.com');
			privateEnv[OWNER] = '   ';
			expect(resolveBootstrapOwnerEmail(undefined)).toBeUndefined();
			delete privateEnv[OWNER];
			expect(resolveBootstrapOwnerEmail(undefined)).toBeUndefined();
		});

		it('honors the unsafe opt-in only for loopback origins on Node', () => {
			privateEnv[UNSAFE] = 'true';
			privateEnv[ORIGIN] = 'http://localhost:5173';
			expect(resolveBootstrapUnsafeContext(undefined)).toEqual({
				unsafeOptIn: true,
				localDevelopment: true
			});
			privateEnv[ORIGIN] = 'https://sign.example.com';
			expect(resolveBootstrapUnsafeContext(undefined)).toEqual({
				unsafeOptIn: true,
				localDevelopment: false
			});
		});

		it('refuses the unsafe opt-in on Cloudflare even with a loopback origin', () => {
			const platform = {
				env: {
					SIGNKIT_ALLOW_UNSAFE_FIRST_USER_BOOTSTRAP: 'true',
					SIGNKIT_PUBLIC_ORIGIN: 'http://localhost:5173'
				}
			};
			expect(resolveBootstrapUnsafeContext(platform as App.Platform)).toEqual({
				unsafeOptIn: true,
				localDevelopment: false
			});
		});

		it('refuses the unsafe opt-in on Vercel even with a loopback origin', () => {
			privateEnv[UNSAFE] = 'true';
			privateEnv[ORIGIN] = 'http://localhost:3000';
			privateEnv[VERCEL] = '1';
			expect(resolveBootstrapUnsafeContext(undefined)).toEqual({
				unsafeOptIn: true,
				localDevelopment: false
			});
		});
	});
});
