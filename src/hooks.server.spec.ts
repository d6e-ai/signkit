import { describe, expect, it } from 'vitest';
import {
	isCookieSessionSuppressed,
	isLocaleExcludedPath,
	isSessionExcludedPath,
	resolveApiKeyBearerMode
} from './hooks.server';

describe('locale exclusions', () => {
	it.each(['/api', '/api/v1/envelopes', '/.well-known/jwks.json', '/health', '/webhooks/sign'])(
		'excludes machine path %s',
		(pathname) => {
			expect(isLocaleExcludedPath(pathname)).toBe(true);
		}
	);

	it.each(['/', '/en', '/ja/agreements', '/templates'])('localizes human path %s', (pathname) => {
		expect(isLocaleExcludedPath(pathname)).toBe(false);
	});
});

describe('session exclusions', () => {
	it('keeps recipient capability routes independent from d6e-auth browser sessions', () => {
		expect(isSessionExcludedPath('/api/v1/signing/context')).toBe(true);
		expect(isSessionExcludedPath('/s/capability')).toBe(true);
		expect(isSessionExcludedPath('/sign')).toBe(true);
		expect(isSessionExcludedPath('/ja/sign')).toBe(true);
		expect(isSessionExcludedPath('/api/v1/envelopes')).toBe(false);
		expect(isSessionExcludedPath('/signature')).toBe(false);
	});
});

describe('bearer mode selection', () => {
	const TOKEN: string = `signkit_${'a'.repeat(43)}`;

	it('stays in cookie mode with no Authorization header', () => {
		expect(resolveApiKeyBearerMode('/api/v1/envelopes', null)).toEqual({ mode: 'cookie' });
	});

	/**
	 * A present-but-empty header is a different input from an absent one -- the
	 * hook observes `''` rather than `null` -- and is deliberately treated the
	 * same, because an all-empty `Authorization` carries no credential and so
	 * cannot compose with a cookie. Asserted through a real `Request` so the
	 * equivalence is pinned against actual Fetch `Headers` behaviour rather than a
	 * hand-written string.
	 */
	it('stays in cookie mode for a present-but-empty Authorization header', () => {
		const url: string = 'https://signkit.example/api/v1/envelopes';
		for (const value of ['', '   ']) {
			const request: Request = new Request(url, { headers: { authorization: value } });
			expect(request.headers.has('authorization')).toBe(true);
			expect(request.headers.get('authorization')).toBe('');
			expect(
				resolveApiKeyBearerMode('/api/v1/envelopes', request.headers.get('authorization'))
			).toEqual({ mode: 'cookie' });
		}
	});

	/**
	 * Appending an empty value alongside a real token cannot smuggle the token past
	 * bearer mode: the joined value is non-empty, so bearer mode is selected, and
	 * the anchored parse then refuses it -- an opaque failure with the cookie
	 * suppressed, never a usable credential.
	 */
	it('enters bearer mode with no token when an empty value is appended to a real one', () => {
		const headers: Headers = new Headers();
		headers.append('authorization', '');
		headers.append('authorization', `Bearer ${TOKEN}`);

		expect(resolveApiKeyBearerMode('/api/v1/envelopes', headers.get('authorization'))).toEqual({
			mode: 'bearer',
			token: null
		});
	});

	it('enters bearer mode with a usable API key on an allowlisted path', () => {
		expect(resolveApiKeyBearerMode('/api/v1/envelopes', `Bearer ${TOKEN}`)).toEqual({
			mode: 'bearer',
			token: TOKEN
		});
	});

	/**
	 * The load-bearing case: an unusable bearer still selects bearer mode, with a
	 * null token. If this returned cookie mode, a malformed or foreign credential
	 * would silently fall back to whatever session accompanied the request.
	 */
	it.each([
		['a malformed API key', `Bearer signkit_${'a'.repeat(10)}`],
		['a recipient capability', `Bearer skr1_${'a'.repeat(43)}`],
		['a completion access grant', `Bearer skca1_${'a'.repeat(43)}`],
		['an instance invitation token', `Bearer ski1_${'a'.repeat(43)}`],
		['a worker secret', `Bearer ${'x'.repeat(48)}`],
		['a Basic credential', 'Basic dXNlcjpwYXNz'],
		['a lowercase scheme', `bearer ${TOKEN}`]
	])('enters bearer mode with no token for %s', (_name, authorization) => {
		expect(resolveApiKeyBearerMode('/api/v1/envelopes', authorization)).toEqual({
			mode: 'bearer',
			token: null
		});
	});

	/**
	 * Off both lists a bearer is not resolved at all, so the recipient surface,
	 * public completion artifacts, the system drains, and browser pages keep their
	 * own credential handling untouched.
	 */
	it.each([
		'/api/v1/signing/context',
		'/api/v1/signing/documents',
		'/api/v1/completion-artifacts',
		'/api/v1/system/deliveries/drain',
		'/api/v1/system/capabilities',
		'/s/skr1_token',
		'/c/skca1_token',
		'/settings',
		'/'
	])('never enters bearer mode on %s', (pathname) => {
		expect(resolveApiKeyBearerMode(pathname, `Bearer ${TOKEN}`)).toEqual({ mode: 'cookie' });
	});

	/**
	 * Management surfaces reject rather than ignore. Ignoring would leave the
	 * accompanying cookie to authorize a request an API key must never reach --
	 * minting a key, granting itself an organization, or administering members --
	 * so the key is refused and the cookie is suppressed along with it.
	 */
	it.each([
		'/api/v1/api-keys',
		'/api/v1/api-keys/01900000-0000-7000-8000-000000000201/revoke',
		'/api/v1/api-keys/01900000-0000-7000-8000-000000000201/organization-grants',
		'/api/v1/api-keys/01900000-0000-7000-8000-000000000201/organization-grants/01900000-0000-7000-8000-000000000301/revoke',
		'/api/v1/instance/members',
		'/api/v1/instance/members/me',
		'/api/v1/instance/members/user-2/role',
		'/api/v1/instance/invitations',
		'/api/v1/instance/invitations/accept'
	])('rejects a well-formed API key outright on %s', (pathname) => {
		expect(resolveApiKeyBearerMode(pathname, `Bearer ${TOKEN}`)).toEqual({ mode: 'rejected' });
	});

	/**
	 * Only a well-formed `signkit_` value is rejected. Anything else on a
	 * management surface is not an API key at all and is left to that endpoint's
	 * own credential handling, exactly as before this slice.
	 */
	it.each([
		['a recipient capability', `Bearer skr1_${'a'.repeat(43)}`],
		['a Basic credential', 'Basic dXNlcjpwYXNz'],
		['a malformed API key', `Bearer signkit_${'a'.repeat(10)}`],
		['no header at all', null]
	])('leaves %s alone on a management surface', (_name, authorization) => {
		expect(resolveApiKeyBearerMode('/api/v1/api-keys', authorization)).toEqual({
			mode: 'cookie'
		});
	});

	/**
	 * Bootstrap is cookie-session-only like the rest of instance management, so a
	 * well-formed API key there is rejected rather than resolved or ignored.
	 */
	it('rejects a well-formed API key on the bootstrap endpoint', () => {
		expect(resolveApiKeyBearerMode('/api/v1/instance/bootstrap', `Bearer ${TOKEN}`)).toEqual({
			mode: 'rejected'
		});
	});
});

describe('cookie session suppression', () => {
	it('keeps the cookie session available only when no bearer was presented', () => {
		expect(isCookieSessionSuppressed({ state: 'absent' })).toBe(false);
	});

	it.each([
		'rejected_surface',
		'invalid_token',
		'organization_selector_invalid',
		'organization_grant_required',
		'integrity_error',
		'unavailable'
	] as const)('suppresses the cookie session for the failing state %s', (state) => {
		expect(isCookieSessionSuppressed({ state })).toBe(true);
	});

	it('suppresses the cookie session for an authenticated key', () => {
		expect(
			isCookieSessionSuppressed({
				state: 'authenticated',
				principal: {
					apiKeyId: '01900000-0000-7000-8000-000000000201',
					keyPrefix: 'signkit_abcdefgh',
					ownerUserId: 'user-1',
					organizationId: 'org-alpha',
					organizationName: 'Alpha',
					scopes: ['envelopes:read'],
					expiresAt: '2026-12-11T00:00:00.000Z'
				}
			})
		).toBe(true);
	});
});
