import { redirect } from '@sveltejs/kit';
import { ORGANIZATION_COOKIE, SESSION_COOKIE } from '$lib/server/session';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies }) => {
	cookies.delete(SESSION_COOKIE, { path: '/' });
	cookies.delete(ORGANIZATION_COOKIE, { path: '/' });
	redirect(302, '/');
};
