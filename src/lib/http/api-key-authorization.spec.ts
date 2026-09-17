import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyPrincipal } from '$lib/ports/api-key-authentication-store';
import type { ApiKeyScope } from '$lib/security/api-key';
import { authorizeScopedInstanceRequest, type AuthorizedApiActor } from './api-key-authorization';
import { authorizeInstanceRequest } from './instance-authorization';
import { authorizeIdentityRequest } from './identity-authorization';
import { instanceScopedLocals } from './http-handler-test-support';

const INSTANCE: string = '/api/v1/envelopes';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';

function principal(overrides: Partial<ApiKeyPrincipal> = {}): ApiKeyPrincipal {
	return {
		apiKeyId: KEY_ID,
		keyPrefix: 'signkit_abcdefgh',
		ownerUserId: 'user-1',
		scopes: ['envelopes:read'],
		expiresAt: '2026-12-11T00:00:00.000Z',
		...overrides
	};
}

function locals(
	apiKeyAuthentication: App.Locals['apiKeyAuthentication'] = { state: 'absent' },
	state: App.Locals['identityState'] = 'active'
): App.Locals {
	return { ...instanceScopedLocals(state), apiKeyAuthentication };
}

async function problem(response: Response): Promise<{ type: string; status: number }> {
	const body = (await response.json()) as { type: string };
	return { type: body.type, status: response.status };
}

describe('authorizeScopedInstanceRequest', () => {
	describe('session authority', () => {
		it('authorizes a session actor and reports the session authority', () => {
			const result = authorizeScopedInstanceRequest(locals(), INSTANCE, 'envelopes:read');

			expect(result).toEqual({
				authority: 'session',
				id: 'user-1',
				createdByUserId: 'user-1',
				name: 'User',
				email: 'user@example.com'
			} satisfies AuthorizedApiActor);
		});

		/**
		 * Scopes are a property of issued credentials, not of people. An active
		 * instance member is not scope-limited, so a scope the key vocabulary
		 * happens not to contain must not lock a session out.
		 */
		it.each(['drafts:write', 'envelopes:read', 'envelopes:send'] as const)(
			'never scope-limits a session actor for %s',
			(scope: ApiKeyScope) => {
				expect(authorizeScopedInstanceRequest(locals(), INSTANCE, scope)).not.toBeInstanceOf(
					Response
				);
			}
		);

		it('rejects an anonymous caller', async () => {
			const result = authorizeScopedInstanceRequest(
				locals({ state: 'absent' }, 'anonymous'),
				INSTANCE,
				'envelopes:read'
			);
			expect(result).toBeInstanceOf(Response);
			expect(await problem(result as Response)).toEqual({
				status: 401,
				type: 'urn:signkit:problem:authentication-required'
			});
		});

		it('rejects a session with no instance membership', async () => {
			const result = authorizeScopedInstanceRequest(
				locals({ state: 'absent' }, 'no_membership'),
				INSTANCE,
				'envelopes:read'
			);
			expect(await problem(result as Response)).toEqual({
				status: 403,
				type: 'urn:signkit:problem:instance-membership-required'
			});
		});

		it('rejects a suspended instance member', async () => {
			const result = authorizeScopedInstanceRequest(
				locals({ state: 'absent' }, 'suspended'),
				INSTANCE,
				'envelopes:read'
			);
			expect(await problem(result as Response)).toEqual({
				status: 403,
				type: 'urn:signkit:problem:instance-membership-suspended'
			});
		});

		it('fails closed when identity is unavailable', async () => {
			const result = authorizeScopedInstanceRequest(
				locals({ state: 'absent' }, 'unavailable'),
				INSTANCE,
				'envelopes:read'
			);
			expect(await problem(result as Response)).toEqual({
				status: 503,
				type: 'urn:signkit:problem:identity-unavailable'
			});
		});
	});

	describe('bearer authority', () => {
		it('authorizes a key that holds the required scope as an instance actor', () => {
			const result = authorizeScopedInstanceRequest(
				locals({ state: 'authenticated', principal: principal() }),
				INSTANCE,
				'envelopes:read'
			);

			expect(result).toEqual({
				authority: 'api_key',
				id: KEY_ID,
				createdByUserId: 'user-1'
			} satisfies AuthorizedApiActor);
		});

		it('attributes key work to the key owner without human identity', () => {
			const result = authorizeScopedInstanceRequest(
				locals({ state: 'authenticated', principal: principal({ ownerUserId: 'user-9' }) }),
				INSTANCE,
				'envelopes:read'
			);

			// A machine actor has no human identity: no name or email travels with
			// it, so reaching for one on a key path is a type error upstream.
			expect(result).toEqual({
				authority: 'api_key',
				id: KEY_ID,
				createdByUserId: 'user-9'
			} satisfies AuthorizedApiActor);
			expect(result).not.toHaveProperty('name');
			expect(result).not.toHaveProperty('email');
		});

		it('refuses a key missing the required scope', async () => {
			const result = authorizeScopedInstanceRequest(
				locals({
					state: 'authenticated',
					principal: principal({ scopes: ['drafts:write'] })
				}),
				INSTANCE,
				'envelopes:read'
			);

			const response = result as Response;
			expect(await problem(response)).toEqual({
				status: 403,
				type: 'urn:signkit:problem:api-key-insufficient-scope'
			});
			expect(response.headers.get('www-authenticate')).toBe(
				'Bearer error="insufficient_scope", scope="envelopes:read"'
			);
		});

		it('answers an unresolvable token with an opaque 401 and a detail-free challenge', async () => {
			const result = authorizeScopedInstanceRequest(
				locals({ state: 'invalid_token' }),
				INSTANCE,
				'envelopes:read'
			);

			const response = result as Response;
			const body: string = await response.clone().text();
			expect(await problem(response)).toEqual({
				status: 401,
				type: 'urn:signkit:problem:api-key-authentication-required'
			});
			// No `error` parameter: encoding `invalid_token` would re-expose the
			// distinction the opaque 401 exists to hide.
			expect(response.headers.get('www-authenticate')).toBe('Bearer');
			// And no credential material anywhere in the body.
			expect(body).not.toContain('signkit_');
		});

		it('answers an exhausted key with a 429 backoff signal', async () => {
			const result = authorizeScopedInstanceRequest(
				locals({ state: 'rate_limited' }),
				INSTANCE,
				'envelopes:read'
			);
			expect(await problem(result as Response)).toEqual({
				status: 429,
				type: 'urn:signkit:problem:api-key-rate-limited'
			});
		});

		/**
		 * Unreachable while the resolution allowlist and the rejected list stay
		 * disjoint, but a read surface must still refuse rather than fall through to
		 * the cookie if they ever overlap.
		 */
		it('refuses a key marked as presented on a rejected surface', async () => {
			const result = authorizeScopedInstanceRequest(
				locals({ state: 'rejected_surface' }),
				INSTANCE,
				'envelopes:read'
			);
			expect(await problem(result as Response)).toEqual({
				status: 403,
				type: 'urn:signkit:problem:api-key-not-permitted'
			});
		});

		it.each(['integrity_error', 'unavailable'] as const)(
			'answers %s with 503 rather than downgrading to unauthenticated',
			async (state) => {
				const result = authorizeScopedInstanceRequest(
					locals({ state }),
					INSTANCE,
					'envelopes:read'
				);
				expect(await problem(result as Response)).toEqual({
					status: 503,
					type: 'urn:signkit:problem:api-key-authentication-unavailable'
				});
			}
		);
	});

	/**
	 * Bearer exclusivity. A presented bearer forfeits the cookie for the whole
	 * request, in both directions: a failing key must never inherit a session, and
	 * a valid session must never rescue a failing key.
	 */
	describe('cookie and bearer never compose', () => {
		it.each([
			['invalid_token', 401],
			['rejected_surface', 403],
			['rate_limited', 429],
			['unavailable', 503],
			['integrity_error', 503]
		] as const)(
			'refuses %s even alongside a fully authorized session cookie',
			async (state, status) => {
				const result = authorizeScopedInstanceRequest(
					locals({ state }),
					INSTANCE,
					'envelopes:read'
				);
				expect(result).toBeInstanceOf(Response);
				expect((result as Response).status).toBe(status);
			}
		);

		it('keeps an authenticated key on its own authority even with a session present', () => {
			const result = authorizeScopedInstanceRequest(
				locals({ state: 'authenticated', principal: principal() }),
				INSTANCE,
				'envelopes:read'
			);
			expect((result as AuthorizedApiActor).authority).toBe('api_key');
			expect((result as AuthorizedApiActor).id).toBe(KEY_ID);
		});
	});
});

describe('session-only defense in depth', () => {
	it.each([
		['authenticated', { state: 'authenticated', principal: principal() }],
		['rejected_surface', { state: 'rejected_surface' }],
		['invalid_token', { state: 'invalid_token' }],
		['rate_limited', { state: 'rate_limited' }],
		['integrity_error', { state: 'integrity_error' }],
		['unavailable', { state: 'unavailable' }]
	] as const)(
		'authorizeInstanceRequest refuses a presented key in state %s',
		async (_name, apiKeyAuthentication) => {
			const result = authorizeInstanceRequest(locals(apiKeyAuthentication), INSTANCE);

			expect(result).toBeInstanceOf(Response);
			expect(await problem(result as Response)).toEqual({
				status: 403,
				type: 'urn:signkit:problem:api-key-not-permitted'
			});
		}
	);

	/**
	 * An API key must never be able to mint another key or administer instance
	 * members. No instance path is on the resolution allowlist today, so this
	 * branch is unreachable in normal operation -- which is exactly why it is
	 * asserted.
	 */
	it.each([
		['authenticated', { state: 'authenticated', principal: principal() }],
		['rejected_surface', { state: 'rejected_surface' }],
		['invalid_token', { state: 'invalid_token' }],
		['rate_limited', { state: 'rate_limited' }],
		['integrity_error', { state: 'integrity_error' }],
		['unavailable', { state: 'unavailable' }]
	] as const)(
		'authorizeIdentityRequest refuses a presented key in state %s',
		async (_name, apiKeyAuthentication) => {
			const result = authorizeIdentityRequest(locals(apiKeyAuthentication), '/api/v1/api-keys');

			expect(result).toBeInstanceOf(Response);
			expect(await problem(result as Response)).toEqual({
				status: 403,
				type: 'urn:signkit:problem:api-key-not-permitted'
			});
		}
	);

	it('still authorizes a session when no key was presented', () => {
		expect(authorizeInstanceRequest(locals(), INSTANCE)).not.toBeInstanceOf(Response);
		const identity = authorizeIdentityRequest(locals(), '/api/v1/api-keys');
		expect(identity).not.toBeInstanceOf(Response);
		expect(identity).toMatchObject({
			id: 'user-1',
			name: 'User',
			email: 'user@example.com',
			emailVerified: false
		});
	});

	it('reports the instance role on the session actor', () => {
		const result = authorizeInstanceRequest(locals(), INSTANCE);
		expect(result).not.toBeInstanceOf(Response);
		expect((result as { role: string }).role).toBe('owner');
	});
});

/**
 * Credential material must never reach a log or a response body, on any path.
 * The bearer token and its hash exist only inside the hooks resolution and the
 * durable snapshot query; by the time any of these surfaces runs, neither value
 * is reachable, and this pins that.
 */
describe('no credential material escapes', () => {
	const TOKEN: string = `signkit_${'a'.repeat(43)}`;
	const TOKEN_HASH: string = 'd'.repeat(64);

	it.each([
		'invalid_token',
		'rate_limited',
		'integrity_error',
		'unavailable',
		'rejected_surface'
	] as const)('emits no token or hash in the %s response', async (state) => {
		const logged: string[] = [];
		const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]): void => {
			logged.push(args.map((arg) => String(arg)).join(' '));
		});
		try {
			const result = authorizeScopedInstanceRequest(locals({ state }), INSTANCE, 'envelopes:read');
			const body: string = await (result as Response).text();

			expect(body).not.toContain(TOKEN);
			expect(body).not.toContain(TOKEN_HASH);
			expect(body).not.toContain('signkit_');
			expect(body).not.toMatch(/[0-9a-f]{64}/);
			expect(logged.join(' ')).not.toContain('signkit_');
		} finally {
			spy.mockRestore();
		}
	});

	it('emits no key prefix in an authorized actor', () => {
		const result = authorizeScopedInstanceRequest(
			locals({ state: 'authenticated', principal: principal() }),
			INSTANCE,
			'envelopes:read'
		);

		// The actor carries no credential-derived value at all, not even the
		// non-secret display prefix: a read handler has no use for it.
		expect(JSON.stringify(result)).not.toContain('signkit_');
	});
});
