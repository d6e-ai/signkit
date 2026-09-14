import { isHttpError, isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceApplicationPort } from '$lib/application/instance/instance-service';
import type { InstanceCallerContext, InstanceMemberMetadata } from '$lib/ports/instance-store';
import { identityOnlyLocals as locals } from '$lib/http/http-handler-test-support';

const resolveInstanceApplication =
	vi.fn<
		(context: {
			platform?: Readonly<App.Platform>;
		}) => Promise<InstanceApplicationPort | null> | InstanceApplicationPort | null
	>();

vi.mock('$lib/application/instance/instance-runtime', () => ({
	resolveInstanceApplication: (context: { platform?: Readonly<App.Platform> }) =>
		resolveInstanceApplication(context)
}));

const { load } = await import('./+layout.server');

const NOW: string = '2026-09-14T00:00:00.000Z';

function activeOwner(): InstanceMemberMetadata {
	return { userId: 'user-1', role: 'owner', status: 'active', createdAt: NOW, updatedAt: NOW };
}

function application(context: InstanceCallerContext | null): InstanceApplicationPort {
	return {
		bootstrapInstance: vi.fn(),
		getCurrentMember: vi.fn(async () => {
			if (context === null) throw new Error('unavailable');
			return context;
		})
	};
}

function event(input: {
	pathname: string;
	search?: string;
	appLocals?: App.Locals;
}): Parameters<typeof load>[0] {
	const url: URL = new URL(`https://signkit.example${input.pathname}${input.search ?? ''}`);
	return {
		locals: input.appLocals ?? locals(),
		platform: undefined,
		url
	} as unknown as Parameters<typeof load>[0];
}

/**
 * `localizeHref` runs outside of any request context in this unit test (there
 * is no `paraglideMiddleware` wrapping it, unlike a real request), so it falls
 * back to prefixing every href with the base locale instead of leaving it
 * bare. Stripping that prefix here keeps these assertions about the layout
 * guard's own redirect targets, not about paraglide's context-free fallback.
 */
function stripLocalePrefix(pathname: string): string {
	return pathname.replace(/^\/(en|ja)(?=\/|$)/, '') || '/';
}

/**
 * Accepts the bare `MaybePromise<T>` that `LayoutServerLoad` may return
 * (SvelteKit's load type permits a synchronous return, not just a `Promise`),
 * so callers can pass `load(...)` directly without a throwaway
 * `Promise.resolve` wrapper at every call site.
 */
async function captureRedirect(result: unknown): Promise<{ status: number; location: string }> {
	try {
		await result;
	} catch (error: unknown) {
		if (isRedirect(error))
			return { status: error.status, location: stripLocalePrefix(error.location) };
		throw error;
	}
	throw new Error('expected a redirect to be thrown');
}

async function captureHttpError(result: unknown): Promise<{ status: number }> {
	try {
		await result;
	} catch (error: unknown) {
		if (isHttpError(error)) return { status: error.status };
		throw error;
	}
	throw new Error('expected an HTTP error to be thrown');
}

describe('root layout access gate', () => {
	beforeEach(() => {
		resolveInstanceApplication.mockReset();
	});

	it('never touches instance state on the recipient surface', async () => {
		const data = await load(event({ pathname: '/sign', appLocals: locals('anonymous') }));
		expect(data).toEqual({});
		expect(resolveInstanceApplication).not.toHaveBeenCalled();
	});

	/**
	 * The signed-out surface must render for an anonymous caller without
	 * redirecting into /auth/login: it is exactly where POST /auth/logout sends
	 * a caller, and redirecting it back into the login gate would restart OAuth
	 * immediately after logout instead of showing a public Sign In action.
	 */
	it('never gates the signed-out surface behind authentication', async () => {
		const data = await load(event({ pathname: '/signed-out', appLocals: locals('anonymous') }));
		expect(data).toEqual({});
		expect(resolveInstanceApplication).not.toHaveBeenCalled();
	});

	it('never gates the signed-out surface behind unavailable identity either', async () => {
		const data = await load(event({ pathname: '/signed-out', appLocals: locals('unavailable') }));
		expect(data).toEqual({});
		expect(resolveInstanceApplication).not.toHaveBeenCalled();
	});

	it('redirects an anonymous caller to /auth/login with a safe same-origin return path', async () => {
		const redirected = await captureRedirect(
			load(
				event({ pathname: '/envelopes', search: '?filter=mine', appLocals: locals('anonymous') })
			)
		);
		expect(redirected.status).toBe(302);
		expect(redirected.location).toBe(
			`/auth/login?return=${encodeURIComponent('/envelopes?filter=mine')}`
		);
		expect(resolveInstanceApplication).not.toHaveBeenCalled();
	});

	it('fails closed with a 503 for unresolvable identity, never redirecting into an OAuth loop', async () => {
		const failed = await captureHttpError(
			load(event({ pathname: '/', appLocals: locals('unavailable') }))
		);
		expect(failed.status).toBe(503);
		expect(resolveInstanceApplication).not.toHaveBeenCalled();
	});

	it('lets a caller with no active organization proceed to instance bootstrap/membership', async () => {
		// `no_active_organization` carries a non-null principal exactly like
		// `authorized` does; this gate's authority is the local instance_member
		// model, never d6e organization membership, so it must never be treated
		// like `anonymous` or `unavailable`.
		resolveInstanceApplication.mockResolvedValue(
			application({ bootstrapped: true, member: activeOwner() })
		);
		const data = await load(
			event({ pathname: '/envelopes', appLocals: locals('no_active_organization') })
		);
		expect(data).toEqual({ email: 'user@example.com', name: 'User', instanceMemberRole: 'owner' });
	});

	it('forces an authenticated caller on an unbootstrapped instance to /setup', async () => {
		resolveInstanceApplication.mockResolvedValue(
			application({ bootstrapped: false, member: null })
		);
		const redirected = await captureRedirect(load(event({ pathname: '/envelopes' })));
		expect(redirected.status).toBe(302);
		expect(redirected.location).toBe('/setup');
	});

	it('lets an authenticated caller stay on /setup while the instance is unbootstrapped, with a null role', async () => {
		resolveInstanceApplication.mockResolvedValue(
			application({ bootstrapped: false, member: null })
		);
		const data = await load(event({ pathname: '/setup' }));
		expect(data).toEqual({ email: 'user@example.com', name: 'User', instanceMemberRole: null });
	});

	it('redirects away from /setup once the instance is already bootstrapped', async () => {
		resolveInstanceApplication.mockResolvedValue(
			application({ bootstrapped: true, member: activeOwner() })
		);
		const redirected = await captureRedirect(load(event({ pathname: '/setup' })));
		expect(redirected.status).toBe(302);
		expect(redirected.location).toBe('/');
	});

	it('confines a non-member of a bootstrapped instance to /settings', async () => {
		resolveInstanceApplication.mockResolvedValue(application({ bootstrapped: true, member: null }));
		const redirected = await captureRedirect(load(event({ pathname: '/envelopes' })));
		expect(redirected.status).toBe(302);
		expect(redirected.location).toBe('/settings');
	});

	it('confines a suspended member to /settings', async () => {
		resolveInstanceApplication.mockResolvedValue(
			application({
				bootstrapped: true,
				member: { ...activeOwner(), role: 'member', status: 'suspended' }
			})
		);
		const redirected = await captureRedirect(load(event({ pathname: '/' })));
		expect(redirected.status).toBe(302);
		expect(redirected.location).toBe('/settings');
	});

	it('lets a non-member reach /settings directly, for invitation acceptance, with a null role', async () => {
		resolveInstanceApplication.mockResolvedValue(application({ bootstrapped: true, member: null }));
		const data = await load(event({ pathname: '/settings' }));
		expect(data).toEqual({ email: 'user@example.com', name: 'User', instanceMemberRole: null });
	});

	it('gives a suspended member reaching /settings a null role, never their suspended role', async () => {
		resolveInstanceApplication.mockResolvedValue(
			application({
				bootstrapped: true,
				member: { ...activeOwner(), status: 'suspended' }
			})
		);
		const data = await load(event({ pathname: '/settings' }));
		expect(data).toEqual({ email: 'user@example.com', name: 'User', instanceMemberRole: null });
	});

	it('grants an active member normal access to any page and reports their real role', async () => {
		resolveInstanceApplication.mockResolvedValue(
			application({ bootstrapped: true, member: activeOwner() })
		);
		const data = await load(event({ pathname: '/envelopes/new' }));
		expect(data).toEqual({ email: 'user@example.com', name: 'User', instanceMemberRole: 'owner' });
	});

	it('reports an active plain member as role "member"', async () => {
		resolveInstanceApplication.mockResolvedValue(
			application({ bootstrapped: true, member: { ...activeOwner(), role: 'member' } })
		);
		const data = await load(event({ pathname: '/envelopes' }));
		expect(data).toEqual({
			email: 'user@example.com',
			name: 'User',
			instanceMemberRole: 'member'
		});
	});

	it('fails closed with a 503, never rendering a normal page, when the durable instance store cannot be resolved', async () => {
		resolveInstanceApplication.mockResolvedValue(null);
		const failed = await captureHttpError(load(event({ pathname: '/envelopes' })));
		expect(failed.status).toBe(503);
	});

	it('fails closed with a 503 when resolving the instance application throws', async () => {
		resolveInstanceApplication.mockRejectedValue(new Error('boom'));
		const failed = await captureHttpError(load(event({ pathname: '/envelopes' })));
		expect(failed.status).toBe(503);
	});

	it('fails closed with a 503 when reading the caller context throws', async () => {
		resolveInstanceApplication.mockResolvedValue(application(null));
		const failed = await captureHttpError(load(event({ pathname: '/envelopes' })));
		expect(failed.status).toBe(503);
	});
});
