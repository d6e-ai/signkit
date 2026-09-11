import { redirect } from '@sveltejs/kit';
import { authorizeUrl } from '$lib/server/d6e-auth';
import { OAUTH_RETURN_COOKIE, OAUTH_STATE_COOKIE, safeReturnPath } from '$lib/server/oauth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url, cookies }) => {
	const state = crypto.randomUUID();
	const options = {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600
	} as const;
	cookies.set(OAUTH_STATE_COOKIE, state, options);
	const returnTo = safeReturnPath(url.searchParams.get('return'));
	if (returnTo) cookies.set(OAUTH_RETURN_COOKIE, returnTo, options);
	redirect(302, authorizeUrl(new URL('/auth/callback', url.origin).toString(), state));
};
