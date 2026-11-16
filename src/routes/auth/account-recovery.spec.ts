import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { OAUTH_RETURN_COOKIE, OAUTH_STATE_COOKIE, OAUTH_SWITCH_COOKIE } from '$lib/server/oauth';
import { SESSION_COOKIE } from '$lib/server/session';
const { exchange, sealMock } = vi.hoisted(() => ({
	exchange: vi.fn(),
	sealMock: vi.fn(async () => 'sealed-session')
}));
vi.mock('$lib/server/d6e-auth', () => ({
	authorizeUrl: (uri: string, state: string, prompt?: string) => {
		const u = new URL('https://auth.example/auth/login');
		u.searchParams.set('redirect_uri', uri);
		u.searchParams.set('state', state);
		if (prompt) u.searchParams.set('prompt', prompt);
		return u.toString();
	},
	exchangeCode: exchange
}));
vi.mock('$lib/server/session', () => ({
	SESSION_COOKIE: 'signkit_session',
	SESSION_COOKIE_OPTIONS: { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 2592000 },
	seal: sealMock
}));
import { GET as login } from './login/+server';
import { POST as switchAccount } from './switch-account/+server';
import { GET as callback } from './callback/+server';
function event(
	path: string,
	initial: Record<string, string> = {},
	origin = 'https://signkit.example'
) {
	const values = new Map(Object.entries(initial));
	const writes: Array<{ name: string; value: string; options: unknown }> = [];
	const deleted: string[] = [];
	const url = new URL('https://signkit.example' + path);
	return {
		url,
		request: new Request(url, { method: 'POST', headers: { origin } }),
		locals: {
			identityState: 'no_membership',
			principal: { subject: 'wrong-subject', email: 'wrong@example.com', name: 'Wrong' }
		},
		cookies: {
			get: (key: string) => values.get(key),
			set: (name: string, value: string, options: unknown) => {
				values.set(name, value);
				writes.push({ name, value, options });
			},
			delete: (name: string) => {
				values.delete(name);
				deleted.push(name);
			}
		},
		values,
		writes,
		deleted
	};
}
async function outcome(fn: () => unknown) {
	try {
		await fn();
	} catch (e) {
		if (isRedirect(e)) return { status: e.status, location: e.location };
		if (isHttpError(e)) return { status: e.status, location: undefined };
		throw e;
	}
	throw new Error('Expected redirect/error');
}
beforeEach(() => {
	exchange.mockReset();
	sealMock.mockClear();
	exchange.mockResolvedValue({
		accessToken: 'access',
		refreshToken: 'refresh',
		expiresIn: 3600,
		principal: {
			subject: 'invited-subject',
			email: 'invited@example.com',
			name: 'Invited',
			emailVerified: true
		}
	});
});
describe('invitation account recovery', () => {
	it.each(['https://foreign.example', 'null'])(
		'rejects origin %s before clearing any session or OAuth state',
		async (origin) => {
			const e = event('/auth/switch-account', { [SESSION_COOKIE]: 'old' }, origin);
			expect(
				(await outcome(() => switchAccount(e as unknown as Parameters<typeof switchAccount>[0])))
					.status
			).toBe(403);
			expect(e.writes).toEqual([]);
			expect(e.deleted).toEqual([]);
		}
	);
	it('clears the local session and begins a fresh, account-selecting flow to the same invitation surface', async () => {
		const e = event('/auth/switch-account', {
			[SESSION_COOKIE]: 'old',
			[OAUTH_STATE_COOKIE]: 'stale'
		});
		const r = await switchAccount(e as unknown as Parameters<typeof switchAccount>[0]);
		expect(r.status).toBe(200);
		expect(r.headers.get('cache-control')).toBe('private, no-store');
		expect(r.headers.has('location')).toBe(false);
		const { authorizeUrl } = (await r.json()) as { authorizeUrl: string };
		const dest = new URL(authorizeUrl);
		expect(dest.searchParams.get('prompt')).toBe('select_account');
		expect(dest.searchParams.get('state')).not.toBe('stale');
		expect(e.deleted).toContain(SESSION_COOKIE);
		expect(e.values.get(OAUTH_RETURN_COOKIE)).toMatch(/\/invitations\/accept$/);
		expect(e.values.get(OAUTH_SWITCH_COOKIE)).toBe(JSON.stringify('wrong-subject'));
		expect(e.writes.find((x) => x.name === OAUTH_SWITCH_COOKIE)?.options).toMatchObject({
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			maxAge: 600
		});
		expect(authorizeUrl).not.toContain('wrong-subject');
		expect(authorizeUrl).not.toContain('ski1_');
	});
	it('normal login clears stale return/switch hints and never accepts a foreign return path', async () => {
		const e = event('/auth/login?return=%2F%2Fforeign.example&prompt=invalid', {
			[OAUTH_RETURN_COOKIE]: '/stale',
			[OAUTH_SWITCH_COOKIE]: 'stale'
		});
		const r = await outcome(() => login(e as unknown as Parameters<typeof login>[0]));
		expect(new URL(r.location!).searchParams.has('prompt')).toBe(false);
		expect(e.values.has(OAUTH_RETURN_COOKIE)).toBe(false);
		expect(e.values.has(OAUTH_SWITCH_COOKIE)).toBe(false);
	});
	it('replaces identity only from the verified code exchange and returns to the invitation', async () => {
		const e = event('/auth/callback?code=valid&state=fresh', {
			[OAUTH_STATE_COOKIE]: 'fresh',
			[OAUTH_RETURN_COOKIE]: '/ja/invitations/accept',
			[OAUTH_SWITCH_COOKIE]: JSON.stringify('wrong-subject')
		});
		expect(await outcome(() => callback(e as unknown as Parameters<typeof callback>[0]))).toEqual({
			status: 302,
			location: '/ja/invitations/accept'
		});
		expect(sealMock).toHaveBeenCalledWith(
			expect.objectContaining({
				principal: expect.objectContaining({ subject: 'invited-subject' })
			})
		);
		expect(e.values.get(SESSION_COOKIE)).toBe('sealed-session');
		expect(e.values.has(OAUTH_STATE_COOKIE)).toBe(false);
	});
	it('shows an explicit recovery message if the provider returns the same account', async () => {
		const e = event('/auth/callback?code=valid&state=fresh', {
			[OAUTH_STATE_COOKIE]: 'fresh',
			[OAUTH_RETURN_COOKIE]: '/en/invitations/accept',
			[OAUTH_SWITCH_COOKIE]: JSON.stringify('invited-subject')
		});
		expect(await outcome(() => callback(e as unknown as Parameters<typeof callback>[0]))).toEqual({
			status: 303,
			location: '/en/invitations/accept?auth=same-account'
		});
	});
	it('preserves a newer OAuth flow and the local session when an older tab returns', async () => {
		const e = event('/auth/callback?code=old&state=old', {
			[OAUTH_STATE_COOKIE]: 'new',
			[OAUTH_RETURN_COOKIE]: '/ja/invitations/accept',
			[SESSION_COOKIE]: 'current'
		});
		expect(
			(await outcome(() => callback(e as unknown as Parameters<typeof callback>[0]))).status
		).toBe(400);
		expect(e.deleted).toEqual([]);
		expect(exchange).not.toHaveBeenCalled();
		expect(e.values.get(SESSION_COOKIE)).toBe('current');
	});
	it('returns a cancelled login to the invitation without consuming or accepting it', async () => {
		const e = event('/auth/callback?error=access_denied&state=fresh', {
			[OAUTH_STATE_COOKIE]: 'fresh',
			[OAUTH_RETURN_COOKIE]: '/ja/invitations/accept'
		});
		expect(await outcome(() => callback(e as unknown as Parameters<typeof callback>[0]))).toEqual({
			status: 303,
			location: '/ja/invitations/accept?auth=cancelled'
		});
		expect(exchange).not.toHaveBeenCalled();
		expect(e.values.has(SESSION_COOKIE)).toBe(false);
	});
	it('returns an exchange outage to a retryable invitation screen', async () => {
		exchange.mockRejectedValueOnce(new Error('outage'));
		const e = event('/auth/callback?code=valid&state=fresh', {
			[OAUTH_STATE_COOKIE]: 'fresh',
			[OAUTH_RETURN_COOKIE]: '/ja/invitations/accept'
		});
		expect(await outcome(() => callback(e as unknown as Parameters<typeof callback>[0]))).toEqual({
			status: 303,
			location: '/ja/invitations/accept?auth=failed'
		});
		expect(e.values.has(SESSION_COOKIE)).toBe(false);
	});
});
