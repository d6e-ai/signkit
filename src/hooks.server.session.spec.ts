import { Buffer } from 'node:buffer';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationMembership, TokenSet, VerifiedPrincipal } from '$lib/server/d6e-auth';
import type { Session } from '$lib/server/session';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

const refresh = vi.fn<(refreshToken: string) => Promise<TokenSet>>();
const organizations = vi.fn<(accessToken: string) => Promise<OrganizationMembership[]>>();
const verifyAccessToken = vi.fn<(token: string) => Promise<VerifiedPrincipal>>();

vi.mock('$lib/server/d6e-auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/d6e-auth')>();
	return { ...actual, refresh, organizations, verifyAccessToken };
});

const { handleSession } = await import('./hooks.server');
const { D6eAuthRejectedError } = await import('$lib/server/d6e-auth');
const { SESSION_COOKIE, seal } = await import('$lib/server/session');

const PRINCIPAL: VerifiedPrincipal = {
	subject: 'user-1',
	email: 'user@example.com',
	name: 'User',
	emailVerified: true
};

const ORGANIZATION: OrganizationMembership = {
	role: 'owner',
	joinedAt: '2026-09-01T00:00:00.000Z',
	organization: { id: 'org-1', slug: 'org-1', name: 'Org One', status: 'active' }
};

interface CookieJar {
	get(name: string): string | undefined;
	set(name: string, value: string, opts: unknown): void;
	delete(name: string, opts: unknown): void;
	has(name: string): boolean;
	deletedNames: string[];
}

function cookieJar(initial: Record<string, string> = {}): CookieJar {
	const store: Map<string, string> = new Map(Object.entries(initial));
	const deletedNames: string[] = [];
	return {
		deletedNames,
		get: (name: string): string | undefined => store.get(name),
		set: (name: string, value: string): void => {
			store.set(name, value);
		},
		delete: (name: string): void => {
			store.delete(name);
			deletedNames.push(name);
		},
		has: (name: string): boolean => store.has(name)
	};
}

async function sealedSession(overrides: Partial<Session> = {}): Promise<string> {
	const session: Session = {
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
		principal: PRINCIPAL,
		...overrides
	};
	return seal(session);
}

function event(cookies: CookieJar): RequestEvent {
	return {
		locals: { apiKeyAuthentication: { state: 'absent' } } as unknown as App.Locals,
		url: new URL('https://signkit.example/envelopes'),
		cookies
	} as unknown as RequestEvent;
}

async function run(cookies: CookieJar): Promise<App.Locals> {
	const evt: RequestEvent = event(cookies);
	await handleSession({
		event: evt,
		resolve: async (): Promise<Response> => new Response('ok')
	} as unknown as Parameters<typeof handleSession>[0]);
	return evt.locals;
}

beforeEach((): void => {
	privateEnv.SESSION_ENCRYPTION_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
	refresh.mockReset();
	organizations.mockReset();
	verifyAccessToken.mockReset();
});

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('handleSession: distinguishing rejection from provider outage', () => {
	it('authorizes normally when verification and organization lookup succeed', async () => {
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		organizations.mockResolvedValue([ORGANIZATION]);

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('authorized');
		expect(locals.principal).toEqual(PRINCIPAL);
		expect(cookies.deletedNames).toEqual([]);
	});

	it('clears the session cookie and falls back to anonymous when the access token is rejected', async () => {
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		verifyAccessToken.mockRejectedValue(new D6eAuthRejectedError('access token rejected'));

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('anonymous');
		expect(locals.principal).toBeNull();
		expect(cookies.deletedNames).toEqual([SESSION_COOKIE]);
		expect(cookies.has(SESSION_COOKIE)).toBe(false);
		expect(organizations).not.toHaveBeenCalled();
	});

	it('fails closed as unavailable, keeping the cookie, on a transient verification failure', async () => {
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		verifyAccessToken.mockRejectedValue(new Error('d6e-auth unreachable'));

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('unavailable');
		expect(locals.principal).toBeNull();
		expect(cookies.deletedNames).toEqual([]);
		expect(cookies.has(SESSION_COOKIE)).toBe(true);
	});

	it('clears the session cookie and falls back to anonymous when the refresh token is rejected', async () => {
		const cookies: CookieJar = cookieJar({
			[SESSION_COOKIE]: await sealedSession({ expiresAt: Math.floor(Date.now() / 1000) - 3600 })
		});
		refresh.mockRejectedValue(new D6eAuthRejectedError('refresh token rejected'));

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('anonymous');
		expect(locals.principal).toBeNull();
		expect(cookies.deletedNames).toEqual([SESSION_COOKIE]);
		expect(verifyAccessToken).not.toHaveBeenCalled();
		expect(organizations).not.toHaveBeenCalled();
	});

	it('fails closed as unavailable, keeping the cookie, on a refresh provider outage', async () => {
		const cookies: CookieJar = cookieJar({
			[SESSION_COOKIE]: await sealedSession({ expiresAt: Math.floor(Date.now() / 1000) - 3600 })
		});
		refresh.mockRejectedValue(new Error('d6e-auth unreachable'));

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('unavailable');
		expect(cookies.deletedNames).toEqual([]);
		expect(cookies.has(SESSION_COOKIE)).toBe(true);
	});

	it('clears the session cookie when the organization lookup rejects the session, even after a successful refresh', async () => {
		const cookies: CookieJar = cookieJar({
			[SESSION_COOKIE]: await sealedSession({ expiresAt: Math.floor(Date.now() / 1000) - 3600 })
		});
		const renewed: TokenSet = {
			accessToken: 'new-access-token',
			refreshToken: 'new-refresh-token',
			expiresIn: 3600,
			principal: PRINCIPAL
		};
		refresh.mockResolvedValue(renewed);
		organizations.mockRejectedValue(new D6eAuthRejectedError('organization lookup rejected'));

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('anonymous');
		expect(locals.principal).toBeNull();
		expect(cookies.deletedNames).toEqual([SESSION_COOKIE]);
		expect(cookies.has(SESSION_COOKIE)).toBe(false);
	});

	it('fails closed as unavailable on a transient organization lookup failure', async () => {
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		organizations.mockRejectedValue(new Error('d6e-auth unreachable'));

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('unavailable');
		expect(cookies.deletedNames).toEqual([]);
		expect(cookies.has(SESSION_COOKIE)).toBe(true);
	});
});
