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

const captureMemberSnapshot = vi.hoisted(() => vi.fn());
const resolveInstanceDisplayApplication = vi.hoisted(() =>
	vi.fn(async () => ({
		captureMemberSnapshot,
		memberDisplays: vi.fn(),
		invitationDisplays: vi.fn()
	}))
);
vi.mock('$lib/application/instance-display/instance-display-runtime', () => ({
	resolveInstanceDisplayApplication
}));

const { handleSession } = await import('./hooks.server');
const { load: loadLayout } = await import('./routes/+layout.server');
const { D6eAuthRejectedError } = await import('$lib/server/d6e-auth');
const { SESSION_COOKIE, seal, unseal } = await import('$lib/server/session');

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

async function runPage(cookies: CookieJar, pathname: string = '/envelopes'): Promise<Response> {
	const evt: RequestEvent = event(cookies);
	evt.url.pathname = pathname;
	return handleSession({
		event: evt,
		resolve: async (resolved): Promise<Response> => {
			const data = await loadLayout(resolved as Parameters<typeof loadLayout>[0]);
			return Response.json(data);
		}
	});
}

beforeEach((): void => {
	privateEnv.SESSION_ENCRYPTION_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
	refresh.mockReset();
	verifyAccessToken.mockReset();
	resolveInstanceApplication.mockReset();
	resolveInstanceApplication.mockResolvedValue(mockInstanceApplication);
	getCurrentMember.mockReset();
	getCurrentMember.mockResolvedValue(DEFAULT_CALLER_CONTEXT);
	captureMemberSnapshot.mockReset();
	captureMemberSnapshot.mockResolvedValue({ outcome: 'recorded' });
	resolveInstanceDisplayApplication.mockClear();
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

describe('hook and root layout membership snapshot', () => {
	it('resolves membership once through the real hook and layout without serializing the cache', async () => {
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		const response = await runPage(cookies);
		expect(await response.json()).toEqual({
			email: PRINCIPAL.email,
			name: PRINCIPAL.name,
			instanceMemberRole: 'owner'
		});
		expect(getCurrentMember).toHaveBeenCalledExactlyOnceWith({ id: PRINCIPAL.subject });
	});

	it('reads membership again on the next request and denies a newly suspended member', async () => {
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		await runPage(cookies);
		getCurrentMember.mockResolvedValue({
			bootstrapped: true,
			member: { ...DEFAULT_CALLER_CONTEXT.member!, status: 'suspended' }
		});
		await expect(runPage(cookies)).rejects.toMatchObject({
			status: 302,
			location: expect.stringMatching(/\/settings$/)
		});
		expect(getCurrentMember).toHaveBeenCalledTimes(2);
	});

	it('does not retry unavailable persistence in the layout or grant setup access', async () => {
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		resolveInstanceApplication.mockResolvedValueOnce(null);
		const cookies: CookieJar = cookieJar({ [SESSION_COOKIE]: await sealedSession() });
		await expect(runPage(cookies, '/setup')).rejects.toMatchObject({ status: 503 });
		expect(resolveInstanceApplication).toHaveBeenCalledTimes(1);
		expect(getCurrentMember).not.toHaveBeenCalled();
	});
});

describe('handleSession: profile observation and display capture', () => {
	const observedAt: string = '2026-09-12T12:00:00.000Z';

	it('preserves profileObservedAt across verifyAccessToken of the same token', async () => {
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		const cookies: CookieJar = cookieJar({
			[SESSION_COOKIE]: await sealedSession({
				profileObservedAt: observedAt,
				profileStoredAt: observedAt
			})
		});
		await run(cookies);
		expect(captureMemberSnapshot).not.toHaveBeenCalled();
		const opened = await unseal(cookies.get(SESSION_COOKIE)!);
		expect(opened?.session.profileObservedAt).toBe(observedAt);
		expect(opened?.session.accessToken).toBe('access-token');
	});

	it('stamps a new profileObservedAt on refresh, not on ordinary membership timestamps', async () => {
		const cookies: CookieJar = cookieJar({
			[SESSION_COOKIE]: await sealedSession({
				expiresAt: Math.floor(Date.now() / 1000) - 3600,
				profileObservedAt: observedAt
			})
		});
		refresh.mockResolvedValue({
			accessToken: 'renewed-access',
			refreshToken: 'renewed-refresh',
			expiresIn: 3600,
			principal: PRINCIPAL
		});
		await run(cookies);
		const opened = await unseal(cookies.get(SESSION_COOKIE)!);
		expect(opened?.session.profileObservedAt).not.toBe(observedAt);
		expect(opened?.session.profileObservedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(opened?.session.accessToken).toBe('renewed-access');
		expect(captureMemberSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: PRINCIPAL.subject,
				observedAt: opened?.session.profileObservedAt
			})
		);
	});

	it('keeps a pre-membership observation and does not capture until local membership exists', async () => {
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		getCurrentMember.mockResolvedValue({ bootstrapped: true, member: null });
		const cookies: CookieJar = cookieJar({
			[SESSION_COOKIE]: await sealedSession({ profileObservedAt: observedAt })
		});
		const locals: App.Locals = await run(cookies);
		expect(locals.identityState).toBe('no_membership');
		expect(captureMemberSnapshot).not.toHaveBeenCalled();
		const opened = await unseal(cookies.get(SESSION_COOKIE)!);
		expect(opened?.session.profileObservedAt).toBe(observedAt);
	});

	it('does not fail authentication when display capture throws, and logs no PII', async () => {
		verifyAccessToken.mockResolvedValue(PRINCIPAL);
		captureMemberSnapshot.mockRejectedValueOnce(
			new Error('ciphertext exploded for user@example.com')
		);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const cookies: CookieJar = cookieJar({
			[SESSION_COOKIE]: await sealedSession({ profileObservedAt: observedAt })
		});
		const locals: App.Locals = await run(cookies);
		expect(locals.identityState).toBe('active');
		expect(locals.principal).toEqual(PRINCIPAL);
		expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('user@example.com');
		errorSpy.mockRestore();
	});
});
