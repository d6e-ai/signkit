import type { Cookies } from '@sveltejs/kit';
import { authorizeUrl } from './d6e-auth';
import {
	OAUTH_RETURN_COOKIE,
	OAUTH_STATE_COOKIE,
	OAUTH_SWITCH_COOKIE,
	safeReturnPath
} from './oauth';
import { newOpaqueToken } from '$lib/security/opaque-token';

export function beginOAuthLogin(
	url: URL,
	cookies: Cookies,
	options: {
		returnTo?: string | null;
		selectAccount?: boolean;
		previousSubject?: string | null;
	} = {}
): string {
	const state = newOpaqueToken();
	const destination = authorizeUrl(
		new URL('/auth/callback', url.origin).toString(),
		state,
		options.selectAccount ? 'select_account' : undefined
	);
	const cookieOptions = {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600
	} as const;
	cookies.set(OAUTH_STATE_COOKIE, state, cookieOptions);
	const returnTo = safeReturnPath(options.returnTo);
	if (returnTo) cookies.set(OAUTH_RETURN_COOKIE, returnTo, cookieOptions);
	else cookies.delete(OAUTH_RETURN_COOKIE, { path: '/' });
	if (options.selectAccount) {
		// This is a display/recovery hint, never an identity credential.
		cookies.set(
			OAUTH_SWITCH_COOKIE,
			JSON.stringify(options.previousSubject ?? null),
			cookieOptions
		);
	} else cookies.delete(OAUTH_SWITCH_COOKIE, { path: '/' });
	return destination;
}
