import { error, redirect } from '@sveltejs/kit';
import { exchangeCode } from '$lib/server/d6e-auth';
import {
	OAUTH_RETURN_COOKIE,
	OAUTH_STATE_COOKIE,
	OAUTH_SWITCH_COOKIE,
	safeReturnPath
} from '$lib/server/oauth';
import { isInvitationSurfacePath } from '$lib/navigation/invitation-surface';
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, seal } from '$lib/server/session';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const expected = cookies.get(OAUTH_STATE_COOKIE);
	const received = url.searchParams.get('state');
	const code = url.searchParams.get('code');
	// A stale callback from another tab must not consume a newer flow.
	if (!expected || !received || expected !== received)
		error(400, 'That sign-in could not be completed.');
	const returnTo = safeReturnPath(cookies.get(OAUTH_RETURN_COOKIE)) ?? '/';
	const switchHint = cookies.get(OAUTH_SWITCH_COOKIE);
	cookies.delete(OAUTH_STATE_COOKIE, { path: '/' });
	cookies.delete(OAUTH_RETURN_COOKIE, { path: '/' });
	cookies.delete(OAUTH_SWITCH_COOKIE, { path: '/' });
	const invitationReturn = isInvitationSurfacePath(new URL(returnTo, url.origin).pathname);
	function recover(reason: 'cancelled' | 'failed' | 'same-account'): never {
		const destination = new URL(returnTo, url.origin);
		destination.searchParams.set('auth', reason);
		redirect(303, destination.pathname + destination.search + destination.hash);
	}
	if (!code || url.searchParams.has('error')) {
		if (invitationReturn) recover('cancelled');
		error(400, 'That sign-in could not be completed.');
	}

	let tokens;
	try {
		tokens = await exchangeCode(code, new URL('/auth/callback', url.origin).toString());
	} catch {
		if (invitationReturn) recover('failed');
		error(502, 'The identity provider could not be reached.');
	}
	const cookie = await seal({
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: Math.floor(Date.now() / 1000) + tokens.expiresIn,
		principal: tokens.principal,
		profileObservedAt: new Date().toISOString()
	});
	cookies.set(SESSION_COOKIE, cookie, {
		...SESSION_COOKIE_OPTIONS,
		secure: url.protocol === 'https:'
	});
	if (invitationReturn && switchHint === JSON.stringify(tokens.principal.subject))
		recover('same-account');
	redirect(302, returnTo);
};
