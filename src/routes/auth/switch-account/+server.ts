import { error, redirect } from '@sveltejs/kit';
import { localizeHref } from '$lib/paraglide/runtime';
import { beginOAuthLogin } from '$lib/server/oauth-login';
import { SESSION_COOKIE } from '$lib/server/session';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, url, cookies, locals }) => {
	if (request.headers.get('origin') !== url.origin) error(403, 'Same-origin request required.');
	const destination = beginOAuthLogin(url, cookies, {
		returnTo: localizeHref('/invitations/accept'),
		selectAccount: true,
		previousSubject: locals.identityState === 'unavailable' ? null : locals.principal?.subject
	});
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, destination);
};
