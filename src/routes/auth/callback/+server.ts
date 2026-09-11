import { error, redirect } from '@sveltejs/kit';
import { exchangeCode } from '$lib/server/d6e-auth';
import { OAUTH_RETURN_COOKIE, OAUTH_STATE_COOKIE } from '$lib/server/oauth';
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, seal } from '$lib/server/session';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const expected = cookies.get(OAUTH_STATE_COOKIE);
	const received = url.searchParams.get('state');
	const code = url.searchParams.get('code');
	cookies.delete(OAUTH_STATE_COOKIE, { path: '/' });
	const returnTo = cookies.get(OAUTH_RETURN_COOKIE) ?? '/';
	cookies.delete(OAUTH_RETURN_COOKIE, { path: '/' });
	if (!expected || !received || expected !== received || !code)
		error(400, 'That sign-in could not be completed.');

	let tokens;
	try {
		tokens = await exchangeCode(code, new URL('/auth/callback', url.origin).toString());
	} catch {
		error(502, 'The identity provider could not be reached.');
	}
	const cookie = await seal({
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: Math.floor(Date.now() / 1000) + tokens.expiresIn,
		principal: tokens.principal
	});
	cookies.set(SESSION_COOKIE, cookie, {
		...SESSION_COOKIE_OPTIONS,
		secure: url.protocol === 'https:'
	});
	redirect(302, returnTo);
};
