import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedBearerAccessToken, VerifiedPrincipal } from '$lib/server/d6e-auth';
import type { InstanceCallerContext } from '$lib/ports/instance-store';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

const verifyBearerAccessToken = vi.fn<(token: string) => Promise<VerifiedBearerAccessToken>>();

vi.mock('$lib/server/d6e-auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/d6e-auth')>();
	return { ...actual, verifyBearerAccessToken };
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
const { D6eAuthRejectedError } = await import('$lib/server/d6e-auth');

const PRINCIPAL: VerifiedPrincipal = {
	subject: 'user-1',
	email: 'user@example.com',
	name: 'User',
	emailVerified: true
};

const ACTIVE_OWNER: InstanceCallerContext = {
	bootstrapped: true,
	member: {
		userId: 'user-1',
		role: 'owner',
		status: 'active',
		createdAt: '2026-09-01T00:00:00.000Z',
		updatedAt: '2026-09-01T00:00:00.000Z'
	}
};

const BEARER_OBSERVED_AT: string = '2026-11-20T09:00:00.000Z';

interface Run {
	locals: App.Locals;
	cookieReads: string[];
}

/**
 * Runs the hook with an optional presented access token. The cookie jar
 * records every read, so a test can prove no operator cookie is consulted.
 */
async function run(
	input: { token?: string; pathname?: string; method?: string; cookie?: string } = {}
): Promise<Run> {
	const cookieReads: string[] = [];
	const url: URL = new URL(
		`https://signkit.example${input.pathname ?? '/api/v1/instance/members/me'}`
	);
	const evt = {
		locals: {
			apiKeyAuthentication: { state: 'absent' },
			accessTokenAuthentication:
				input.token === undefined ? { state: 'absent' } : { state: 'presented', token: input.token }
		} as unknown as App.Locals,
		url,
		request: new Request(url, { method: input.method ?? 'GET' }),
		cookies: {
			get: (name: string): string | undefined => {
				cookieReads.push(name);
				return input.cookie;
			},
			set: vi.fn(),
			delete: vi.fn()
		}
	} as unknown as RequestEvent;
	await handleSession({
		event: evt,
		resolve: async (): Promise<Response> => new Response('ok')
	} as unknown as Parameters<typeof handleSession>[0]);
	return { locals: evt.locals, cookieReads };
}

beforeEach((): void => {
	verifyBearerAccessToken.mockReset();
	resolveInstanceApplication.mockReset();
	resolveInstanceApplication.mockResolvedValue(mockInstanceApplication);
	getCurrentMember.mockReset();
	getCurrentMember.mockResolvedValue(ACTIVE_OWNER);
	captureMemberSnapshot.mockReset();
	captureMemberSnapshot.mockResolvedValue({ outcome: 'recorded' });
	resolveInstanceDisplayApplication.mockClear();
});

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('handleSession without a presented access token', () => {
	it('stays anonymous and never reads a cookie, even an old operator session cookie', async () => {
		const { locals, cookieReads } = await run({
			pathname: '/api/v1/dashboard',
			cookie: 'old-sealed-session'
		});

		expect(locals.identityState).toBe('anonymous');
		expect(locals.principal).toBeNull();
		expect(cookieReads).toEqual([]);
		expect(verifyBearerAccessToken).not.toHaveBeenCalled();
		expect(getCurrentMember).not.toHaveBeenCalled();
	});
});

describe('handleSession: access-token bearer mode', () => {
	it('resolves the member from the token', async () => {
		verifyBearerAccessToken.mockResolvedValue({
			principal: PRINCIPAL,
			observedAt: BEARER_OBSERVED_AT
		});

		const { locals, cookieReads } = await run({
			token: 'presented-access-token',
			pathname: '/api/v1/dashboard'
		});

		expect(verifyBearerAccessToken).toHaveBeenCalledExactlyOnceWith('presented-access-token');
		expect(locals.identityState).toBe('active');
		expect(locals.principal).toEqual(PRINCIPAL);
		expect(locals.instanceMembership).toEqual({
			userId: 'user-1',
			role: 'owner',
			status: 'active'
		});
		expect(locals.accessTokenAuthentication).toEqual({
			state: 'verified',
			observedAt: BEARER_OBSERVED_AT
		});
		expect(cookieReads).toEqual([]);
		// Not on the self-profile read, so no display capture either.
		expect(captureMemberSnapshot).not.toHaveBeenCalled();
	});

	it('marks a verified identity without a member row as no_membership', async () => {
		verifyBearerAccessToken.mockResolvedValue({ principal: PRINCIPAL, observedAt: null });
		getCurrentMember.mockResolvedValue({ bootstrapped: true, member: null });

		const { locals } = await run({ token: 't' });

		expect(locals.identityState).toBe('no_membership');
		expect(locals.principal).toEqual(PRINCIPAL);
		expect(locals.instanceMembership).toBeNull();
	});

	it('marks a suspended member as suspended', async () => {
		verifyBearerAccessToken.mockResolvedValue({ principal: PRINCIPAL, observedAt: null });
		getCurrentMember.mockResolvedValue({
			bootstrapped: true,
			member: { ...ACTIVE_OWNER.member!, status: 'suspended' }
		});

		const { locals } = await run({ token: 't' });

		expect(locals.identityState).toBe('suspended');
	});

	it('captures the display snapshot from the token on the self-profile read only', async () => {
		verifyBearerAccessToken.mockResolvedValue({
			principal: PRINCIPAL,
			observedAt: BEARER_OBSERVED_AT
		});

		await run({ token: 't' });

		expect(captureMemberSnapshot).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				userId: PRINCIPAL.subject,
				name: PRINCIPAL.name,
				email: PRINCIPAL.email,
				observedAt: BEARER_OBSERVED_AT
			})
		);

		captureMemberSnapshot.mockClear();
		await run({ token: 't', method: 'POST' });
		expect(captureMemberSnapshot).not.toHaveBeenCalled();
	});

	it('does not capture an unverified email or a token without an observation', async () => {
		verifyBearerAccessToken.mockResolvedValueOnce({
			principal: { ...PRINCIPAL, emailVerified: false },
			observedAt: BEARER_OBSERVED_AT
		});
		await run({ token: 't' });
		verifyBearerAccessToken.mockResolvedValueOnce({ principal: PRINCIPAL, observedAt: null });
		await run({ token: 't' });

		expect(captureMemberSnapshot).not.toHaveBeenCalled();
	});

	it('does not fail identity resolution when display capture throws, and logs no PII', async () => {
		verifyBearerAccessToken.mockResolvedValue({
			principal: PRINCIPAL,
			observedAt: BEARER_OBSERVED_AT
		});
		captureMemberSnapshot.mockRejectedValue(new Error('store down for user@example.com'));
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const { locals } = await run({ token: 't' });
			expect(locals.identityState).toBe('active');
			expect(JSON.stringify(consoleError.mock.calls)).not.toContain('user@example.com');
		} finally {
			consoleError.mockRestore();
		}
	});

	it('answers a rejected token as anonymous', async () => {
		verifyBearerAccessToken.mockRejectedValue(new D6eAuthRejectedError('rejected'));

		const { locals } = await run({ token: 't' });

		expect(locals.identityState).toBe('anonymous');
		expect(locals.principal).toBeNull();
		expect(locals.accessTokenAuthentication).toEqual({ state: 'rejected' });
		expect(getCurrentMember).not.toHaveBeenCalled();
	});

	it('answers a provider outage as unavailable', async () => {
		verifyBearerAccessToken.mockRejectedValue(new Error('jwks unreachable'));

		const { locals } = await run({ token: 't' });

		expect(locals.identityState).toBe('unavailable');
		expect(locals.accessTokenAuthentication).toEqual({ state: 'unavailable' });
	});

	it('fails closed as unavailable when the instance store cannot be resolved', async () => {
		verifyBearerAccessToken.mockResolvedValue({ principal: PRINCIPAL, observedAt: null });
		resolveInstanceApplication.mockResolvedValue(null);

		const { locals } = await run({ token: 't' });

		expect(locals.identityState).toBe('unavailable');
	});

	it('fails closed as unavailable when membership cannot be read', async () => {
		verifyBearerAccessToken.mockResolvedValue({ principal: PRINCIPAL, observedAt: null });
		getCurrentMember.mockRejectedValue(new Error('durable store unreachable'));

		const { locals } = await run({ token: 't' });

		expect(locals.identityState).toBe('unavailable');
		expect(locals.principal).toBeNull();
		expect(locals.instanceMembership).toBeNull();
	});
});
