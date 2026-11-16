import { redirect } from '@sveltejs/kit';
import { beginOAuthLogin } from '$lib/server/oauth-login';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url, cookies, locals }) => {
	redirect(
		302,
		beginOAuthLogin(url, cookies, {
			returnTo: url.searchParams.get('return'),
			selectAccount: url.searchParams.get('prompt') === 'select_account',
			previousSubject: locals.principal?.subject
		})
	);
};
