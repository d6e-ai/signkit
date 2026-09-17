import { Buffer } from 'node:buffer';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenSet, VerifiedPrincipal } from '$lib/server/d6e-auth';
import type { InstanceCallerContext } from '$lib/ports/instance-store';
import type { Session } from '$lib/server/session';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

const refresh = vi.fn<(refreshToken: string) => Promise<TokenSet>>();
const verifyAccessToken = vi.fn<(token: string) => Promise<VerifiedPrincipal>>();

vi.mock('$lib/server/d6e-auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/d6e-auth')>();
	return { ...actual, refresh, verifyAccessToken };
});

const getCurrentMember = vi.fn<(actor: { id: string }) => Promise<InstanceCallerContext>>();
const mockInstanceApplication = { getCurrentMember };
const resolveInstanceApplication = vi.fn().mockResolvedValue(mockInstanceApplication);

vi.mock('$lib/application/instance/instance-runtime', () => ({
	resolveInstanceApplication
}));

const { handleSession } = await import('./hooks.server');
const { D6eAuthRejectedError } = await import('$lib/server/d6e-auth');
const { SESSION_COOKIE, seal } = await import('$lib/server/session');

const PRINCIPAL: VerifiedPrincipal = {
	subject: 'user-1',
	email: 'user@example.com',
	name: 'User',
	emailVerified: true
};

const DEFAULT_CALLER_CONTEXT: InstanceCallerContext = {
	bootstrapped: true,
	member: {
		userId: 'user-1',
		role: 'owner',
		status: 'active',
		createdAt: '2026-09-01T00:00:00.000Z',
		updatedAt: '2026-09-01T00:00:00.000Z'
	}
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
	verifyAccessToken.mockReset();
	resolveInstanceApplication.mockReset();
	resolveInstanceApplication.mockResolvedValue(mockInstanceApplication);
	getCurrentMember.mockReset();
	getCurrentMember.mockResolvedValue(DEFAULT_CALLER_CONTEXT);
});

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('handleSession: distinguishing rejection from provider outage', () => {
	it('authorizes normally when verification and instance member lookup succeed', async () => {
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		verifyAccessToken.mockResolvedValue(PRINCIPAL);

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('active');
		expect(locals.principal).toEqual(PRINCIPAL);
		expect(locals.instanceMembership).toEqual({
			userId: 'user-1',
			role: 'owner',
			status: 'active'
		});
		expect(locals.bootstrapped).toBe(true);
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
		expect(getCurrentMember).not.toHaveBeenCalled();
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
		expect(getCurrentMember).not.toHaveBeenCalled();
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

	it('marks identity as no_membership when verified identity has no member row', async () => {
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		getCurrentMember.mockResolvedValue({
			bootstrapped: true,
			member: null
		});

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('no_membership');
		expect(locals.principal).toEqual(PRINCIPAL);
		expect(locals.instanceMembership).toBeNull();
		expect(locals.bootstrapped).toBe(true);
		expect(cookies.deletedNames).toEqual([]);
	});

	it('marks identity as suspended when member status is suspended', async () => {
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		getCurrentMember.mockResolvedValue({
			bootstrapped: true,
			member: {
				userId: 'user-1',
				role: 'member',
				status: 'suspended',
				createdAt: '2026-09-01T00:00:00.000Z',
				updatedAt: '2026-09-01T00:00:00.000Z'
			}
		});

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('suspended');
		expect(locals.principal).toEqual(PRINCIPAL);
		expect(locals.instanceMembership).toEqual({
			userId: 'user-1',
			role: 'member',
			status: 'suspended'
		});
	});

	it('fails closed as unavailable when instance application cannot be resolved', async () => {
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		resolveInstanceApplication.mockResolvedValueOnce(null);

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('unavailable');
		expect(locals.principal).toEqual(PRINCIPAL);
		expect(locals.instanceMembership).toBeNull();
		expect(cookies.deletedNames).toEqual([]);
		expect(cookies.has(SESSION_COOKIE)).toBe(true);
	});

	it('fails closed as unavailable on a transient instance lookup error', async () => {
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		getCurrentMember.mockRejectedValue(new Error('durable store unreachable'));

		const locals: App.Locals = await run(cookies);

		expect(locals.identityState).toBe('unavailable');
		expect(cookies.deletedNames).toEqual([]);
		expect(cookies.has(SESSION_COOKIE)).toBe(true);
	});
});
