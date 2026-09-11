import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { organizations, refresh, verifyAccessToken } from '$lib/server/d6e-auth';
import {
	ORGANIZATION_COOKIE,
	SESSION_COOKIE,
	SESSION_COOKIE_OPTIONS,
	isExpiring,
	seal,
	unseal
} from '$lib/server/session';

export function isLocaleExcludedPath(pathname: string): boolean {
	return ['/api', '/.well-known', '/health', '/ready', '/webhooks', '/agent'].some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
}

export function isSessionExcludedPath(pathname: string): boolean {
	return pathname === '/api/v1/signing' || pathname.startsWith('/api/v1/signing/');
}

const handleLocale: Handle = ({ event, resolve }) => {
	if (isLocaleExcludedPath(event.url.pathname)) return resolve(event);

	return paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;
		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html
					.replace('%paraglide.lang%', locale)
					.replace('%paraglide.dir%', getTextDirection(locale))
		});
	});
};

const handleSession: Handle = async ({ event, resolve }) => {
	event.locals.principal = null;
	event.locals.memberships = [];
	event.locals.organizationId = null;
	event.locals.identityState = 'anonymous';
	if (isSessionExcludedPath(event.url.pathname)) return resolve(event);

	const cookie = event.cookies.get(SESSION_COOKIE);
	if (!cookie) return resolve(event);
	let session = await unseal(cookie);
	if (!session) {
		event.cookies.delete(SESSION_COOKIE, { path: '/' });
		return resolve(event);
	}

	try {
		if (isExpiring(session) && session.refreshToken) {
			const renewed = await refresh(session.refreshToken);
			session = {
				accessToken: renewed.accessToken,
				refreshToken: renewed.refreshToken ?? session.refreshToken,
				expiresAt: Math.floor(Date.now() / 1000) + renewed.expiresIn,
				principal: renewed.principal
			};
			event.cookies.set(SESSION_COOKIE, await seal(session), {
				...SESSION_COOKIE_OPTIONS,
				secure: event.url.protocol === 'https:'
			});
		} else {
			session.principal = await verifyAccessToken(session.accessToken);
		}

		const activeMemberships = await organizations(session.accessToken);
		const remembered = event.cookies.get(ORGANIZATION_COOKIE);
		const selected =
			activeMemberships.find((membership) => membership.organization.id === remembered) ??
			activeMemberships[0] ??
			null;
		event.locals.principal = session.principal;
		event.locals.memberships = activeMemberships;
		event.locals.organizationId = selected?.organization.id ?? null;
		event.locals.identityState = selected ? 'authorized' : 'no_active_organization';
	} catch (error) {
		console.error(
			JSON.stringify({
				event: 'identity_resolution_failed',
				message: error instanceof Error ? error.message : 'unknown error'
			})
		);
		event.locals.identityState = 'unavailable';
	}

	return resolve(event);
};

export const handle: Handle = sequence(handleLocale, handleSession);
