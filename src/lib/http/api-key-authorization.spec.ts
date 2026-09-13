import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyPrincipal } from '$lib/ports/api-key-authentication-store';
import type { ApiKeyScope } from '$lib/security/api-key';
import {
	authorizeScopedOrganizationRequest,
	type AuthorizedApiActor
} from './api-key-authorization';
import { authorizeOrganizationRequest } from './organization-authorization';
import { authorizeIdentityRequest } from './identity-authorization';

const INSTANCE: string = '/api/v1/envelopes';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';

function principal(overrides: Partial<ApiKeyPrincipal> = {}): ApiKeyPrincipal {
	return {
		apiKeyId: KEY_ID,
		keyPrefix: 'signkit_abcdefgh',
		ownerUserId: 'user-1',
		organizationId: 'org-alpha',
		organizationName: 'Alpha',
		scopes: ['envelopes:read'],
		expiresAt: '2026-12-11T00:00:00.000Z',
		...overrides
	};
}

function locals(overrides: Partial<App.Locals> = {}): App.Locals {
	return {
		apiKeyAuthentication: { state: 'absent' },
		identityState: 'authorized',
		memberships: [
			{
				role: 'owner',
				joinedAt: '2026-09-01T00:00:00.000Z',
				organization: { id: 'org-session', slug: 'session', name: 'Session', status: 'active' }
			}
		],
		organizationId: 'org-session',
		principal: { subject: 'user-1', email: 'user@example.com', name: 'User' },
		...overrides
	};
}

async function problem(response: Response): Promise<{ type: string; status: number }> {
	const body = (await response.json()) as { type: string };
	return { type: body.type, status: response.status };
}

describe('authorizeScopedOrganizationRequest', () => {
	describe('session authority', () => {
		it('authorizes a session actor and reports the session authority', () => {
			const result = authorizeScopedOrganizationRequest(locals(), INSTANCE, 'envelopes:read');

			expect(result).toEqual({
				authority: 'session',
				id: 'user-1',
				organizationId: 'org-session',
				organizationName: 'Session'
			} satisfies AuthorizedApiActor);
		});

		/**
		 * Scopes are a property of issued credentials, not of people. A human with
		 * live d6e organization authority is not scope-limited, so a scope the key
		 * vocabulary happens not to contain must not lock a session out.
		 */
		it.each(['audit:read', 'drafts:write', 'envelopes:read', 'envelopes:send'] as const)(
			'never scope-limits a session actor for %s',
			(scope: ApiKeyScope) => {
				expect(authorizeScopedOrganizationRequest(locals(), INSTANCE, scope)).not.toBeInstanceOf(
					Response
				);
			}
		);

		it('rejects an anonymous caller', async () => {
			const result = authorizeScopedOrganizationRequest(
				locals({ identityState: 'anonymous', principal: null, organizationId: null }),
				INSTANCE,
				'envelopes:read'
			);
			expect(result).toBeInstanceOf(Response);
			expect(await problem(result as Response)).toEqual({
				status: 401,
				type: 'urn:signkit:problem:authentication-required'
			});
		});

		it('rejects a session with no active organization', async () => {
			const result = authorizeScopedOrganizationRequest(
				locals({ identityState: 'no_active_organization', organizationId: null, memberships: [] }),
				INSTANCE,
				'envelopes:read'
			);
			expect(await problem(result as Response)).toEqual({
				status: 403,
				type: 'urn:signkit:problem:organization-required'
			});
		});
	});

	describe('bearer authority', () => {
		it('authorizes a key that holds the required scope for the requested organization', () => {
			const result = authorizeScopedOrganizationRequest(
				locals({ apiKeyAuthentication: { state: 'authenticated', principal: principal() } }),
				INSTANCE,
				'envelopes:read'
			);

			expect(result).toEqual({
				authority: 'api_key',
				id: KEY_ID,
				organizationId: 'org-alpha',
				organizationName: 'Alpha'
			} satisfies AuthorizedApiActor);
		});

		/**
		 * The organization comes from the grant the key proved, never from the
		 * session's own selected organization. Otherwise a key could be steered into
		 * a tenant it was never granted.
		 */
		it('uses the granted organization and never the session organization', () => {
			const result = authorizeScopedOrganizationRequest(
				locals({
					apiKeyAuthentication: { state: 'authenticated', principal: principal() },
					organizationId: 'org-session'
				}),
				INSTANCE,
				'envelopes:read'
			);
			expect((result as AuthorizedApiActor).organizationId).toBe('org-alpha');
		});

		it('refuses a key missing the required scope', async () => {
			const result = authorizeScopedOrganizationRequest(
				locals({
					apiKeyAuthentication: {
						state: 'authenticated',
						principal: principal({ scopes: ['audit:read'] })
					}
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
			const result = authorizeScopedOrganizationRequest(
				locals({ apiKeyAuthentication: { state: 'invalid_token' } }),
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

		it('answers a missing or malformed organization selector with a 400', async () => {
			const result = authorizeScopedOrganizationRequest(
				locals({ apiKeyAuthentication: { state: 'organization_selector_invalid' } }),
				INSTANCE,
				'envelopes:read'
			);

			const response = result as Response;
			expect(await problem(response)).toEqual({
				status: 400,
				type: 'urn:signkit:problem:api-key-organization-selector-required'
			});
			// The selector is a request-shape error and carries no bearer challenge,
			// because it is decided before the credential is ever read.
			expect(response.headers.get('www-authenticate')).toBeNull();
		});

		it('answers a live key with no grant for the requested organization with a 403', async () => {
			const result = authorizeScopedOrganizationRequest(
				locals({ apiKeyAuthentication: { state: 'organization_grant_required' } }),
				INSTANCE,
				'envelopes:read'
			);
			expect(await problem(result as Response)).toEqual({
				status: 403,
				type: 'urn:signkit:problem:api-key-organization-grant-required'
			});
		});

		/**
		 * Unreachable while the resolution allowlist and the rejected list stay
		 * disjoint, but a read surface must still refuse rather than fall through to
		 * the cookie if they ever overlap.
		 */
		it('refuses a key marked as presented on a rejected surface', async () => {
			const result = authorizeScopedOrganizationRequest(
				locals({ apiKeyAuthentication: { state: 'rejected_surface' } }),
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
				const result = authorizeScopedOrganizationRequest(
					locals({ apiKeyAuthentication: { state } }),
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
			['organization_grant_required', 403],
			['organization_selector_invalid', 400],
			['unavailable', 503],
			['integrity_error', 503]
		] as const)(
			'refuses %s even alongside a fully authorized session cookie',
			async (state, status) => {
				const result = authorizeScopedOrganizationRequest(
					locals({
						apiKeyAuthentication: { state },
						identityState: 'authorized',
						organizationId: 'org-session'
					}),
					INSTANCE,
					'envelopes:read'
				);
				expect(result).toBeInstanceOf(Response);
				expect((result as Response).status).toBe(status);
			}
		);

		it('keeps an authenticated key on its own organization even with a session present', () => {
			const result = authorizeScopedOrganizationRequest(
				locals({ apiKeyAuthentication: { state: 'authenticated', principal: principal() } }),
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
		['organization_grant_required', { state: 'organization_grant_required' }],
		['organization_selector_invalid', { state: 'organization_selector_invalid' }],
		['integrity_error', { state: 'integrity_error' }],
		['unavailable', { state: 'unavailable' }]
	] as const)(
		'authorizeOrganizationRequest refuses a presented key in state %s',
		async (_name, apiKeyAuthentication) => {
			const result = authorizeOrganizationRequest(locals({ apiKeyAuthentication }), INSTANCE);

			expect(result).toBeInstanceOf(Response);
			expect(await problem(result as Response)).toEqual({
				status: 403,
				type: 'urn:signkit:problem:api-key-not-permitted'
			});
		}
	);

	/**
	 * An API key must never be able to mint another key, grant itself an
	 * organization, or administer instance members. No instance path is on the
	 * resolution allowlist today, so this branch is unreachable in normal
	 * operation -- which is exactly why it is asserted.
	 */
	it.each([
		['authenticated', { state: 'authenticated', principal: principal() }],
		['rejected_surface', { state: 'rejected_surface' }],
		['invalid_token', { state: 'invalid_token' }],
		['unavailable', { state: 'unavailable' }]
	] as const)(
		'authorizeIdentityRequest refuses a presented key in state %s',
		async (_name, apiKeyAuthentication) => {
			const result = authorizeIdentityRequest(locals({ apiKeyAuthentication }), '/api/v1/api-keys');

			expect(result).toBeInstanceOf(Response);
			expect(await problem(result as Response)).toEqual({
				status: 403,
				type: 'urn:signkit:problem:api-key-not-permitted'
			});
		}
	);

	it('still authorizes a session when no key was presented', () => {
		expect(authorizeOrganizationRequest(locals(), INSTANCE)).not.toBeInstanceOf(Response);
		expect(authorizeIdentityRequest(locals(), '/api/v1/api-keys')).not.toBeInstanceOf(Response);
	});

	it('reports the verified d6e organization role on the session actor', () => {
		const result = authorizeOrganizationRequest(locals(), INSTANCE);
		expect(result).not.toBeInstanceOf(Response);
		expect((result as { organizationRole: string }).organizationRole).toBe('owner');
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
		'organization_selector_invalid',
		'organization_grant_required',
		'integrity_error',
		'unavailable',
		'rejected_surface'
	] as const)('emits no token or hash in the %s response', async (state) => {
		const logged: string[] = [];
		const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]): void => {
			logged.push(args.map((arg) => String(arg)).join(' '));
		});
		try {
			const result = authorizeScopedOrganizationRequest(
				locals({ apiKeyAuthentication: { state } }),
				INSTANCE,
				'envelopes:read'
			);
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
		const result = authorizeScopedOrganizationRequest(
			locals({ apiKeyAuthentication: { state: 'authenticated', principal: principal() } }),
			INSTANCE,
			'envelopes:read'
		);

		// The actor carries no credential-derived value at all, not even the
		// non-secret display prefix: a read handler has no use for it.
		expect(JSON.stringify(result)).not.toContain('signkit_');
	});
});
