import { redirect } from '@sveltejs/kit';
import { localizeHref } from '$lib/paraglide/runtime';
import { ORGANIZATION_COOKIE, SESSION_COOKIE } from '$lib/server/session';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies }) => {
	cookies.delete(SESSION_COOKIE, { path: '/' });
	cookies.delete(ORGANIZATION_COOKIE, { path: '/' });
	// Not `/`: the root layout gate redirects an anonymous caller straight into
	// `/auth/login`, which would restart the OAuth flow the instant logout
	// finishes. `/signed-out` is a public page exempt from that gate, so the
	// caller lands somewhere real instead of bouncing back into sign-in.
	redirect(302, localizeHref('/signed-out'));
};
