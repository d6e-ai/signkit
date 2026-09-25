import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import {
	resolveApiKeyAuthentication,
	type ApiKeyAuthenticationRuntimeContext
} from '$lib/application/api-keys/api-key-authentication-runtime';
import { resolveInstanceApplication } from '$lib/application/instance/instance-runtime';
import { isApiKeyAuthenticatedPath, isApiKeyRejectedPath } from '$lib/navigation/api-key-surface';
import { isRecipientSurfacePath } from '$lib/navigation/recipient-surface';
import { hasAuthorizationHeader, parseBearerApiKey } from '$lib/security/api-key';
import { D6eAuthRejectedError, refresh, verifyAccessToken } from '$lib/server/d6e-auth';
import type { ApiKeyAuthenticationPort } from '$lib/application/api-keys/api-key-authentication';
import {
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
	return (
		pathname === '/api/v1/signing' ||
		pathname.startsWith('/api/v1/signing/') ||
		pathname === '/api/v1/recipient' ||
		pathname.startsWith('/api/v1/recipient/') ||
		isRecipientSurfacePath(pathname)
	);
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

/**
 * Whether this request is in bearer mode, and if so which token it presented.
 *
 * Extracted as a pure function because it encodes the two rules the rest of the
 * pipeline depends on and both must be directly testable:
 *
 * - resolution happens only on the narrow API key path allowlist, so a route
 *   added tomorrow is closed to keys until someone opens it deliberately;
 * - the *presence* of an `Authorization` header selects bearer mode, not its
 *   validity. A `token` of `null` still means bearer mode, which is what makes a
 *   malformed or foreign credential fail closed instead of falling back to a
 *   cookie session that happened to accompany it.
 */
export function resolveApiKeyBearerMode(
	pathname: string,
	authorization: string | null
): { mode: 'cookie' } | { mode: 'bearer'; token: string | null } | { mode: 'rejected' } {
	// Management surfaces are checked first. A well-formed API key there is an
	// error, not something to ignore: ignoring it would let the accompanying
	// cookie authorize a request an API key must never be able to reach, so it is
	// refused outright and the cookie is suppressed with it.
	if (isApiKeyRejectedPath(pathname) && parseBearerApiKey(authorization) !== null) {
		return { mode: 'rejected' };
	}
	if (!isApiKeyAuthenticatedPath(pathname)) return { mode: 'cookie' };
	if (!hasAuthorizationHeader(authorization)) return { mode: 'cookie' };
	return { mode: 'bearer', token: parseBearerApiKey(authorization) };
}

/**
 * Whether the cookie session must be left unresolved for this request.
 *
 * True for every bearer-mode state, including the failing ones. Resolving a
 * cookie alongside a presented bearer would reintroduce exactly the composition
 * this design forbids: an attacker-supplied bearer riding a victim's session.
 */
export function isCookieSessionSuppressed(
	authentication: App.Locals['apiKeyAuthentication']
): boolean {
	return authentication.state !== 'absent';
}

/**
 * Resolves a `signkit_` bearer token into an instance authority, before any
 * cookie session is considered.
 *
 * Three properties matter here and all of them are load-bearing:
 *
 * 1. Resolution happens only on the narrow `isApiKeyAuthenticatedPath`
 *    allowlist. API key and instance management, the recipient surface, public
 *    completion artifacts, and the system drains never resolve a key, so a key
 *    presented there cannot authenticate regardless of endpoint behaviour.
 * 2. The mere presence of an `Authorization` header -- not its validity --
 *    selects bearer mode. Anything other than `absent` makes `handleSession`
 *    skip the cookie entirely, so a malformed bearer, a foreign credential
 *    family, or an unauthorized key can never fall back to a browser session
 *    that happened to ride along on the same request.
 * 3. Authentication is live key plus active owner plus scopes only, answered
 *    from one durable snapshot. No tenant selector participates.
 *
 * A store that cannot be resolved is `unavailable`, never `absent`: a deployment
 * without a configured database must fail closed rather than silently demote
 * every agent request to anonymous and hand it to the cookie path.
 */
export const handleApiKeyAuthentication: Handle = async ({ event, resolve }) => {
	event.locals.apiKeyAuthentication = { state: 'absent' };
	const bearer = resolveApiKeyBearerMode(
		event.url.pathname,
		event.request.headers.get('authorization')
	);
	if (bearer.mode === 'cookie') return resolve(event);
	if (bearer.mode === 'rejected') {
		// No durable read at all: the refusal follows from where the key was
		// presented, so there is nothing to look up and nothing to disclose.
		event.locals.apiKeyAuthentication = { state: 'rejected_surface' };
		return resolve(event);
	}

	// From here on the request is in bearer mode and can no longer use a cookie,
	// whatever the header turned out to contain.
	const token: string | null = bearer.token;
	if (token === null) {
		// A non-`signkit_` bearer -- a recipient capability, a completion grant, an
		// invitation token, a worker secret, or plain garbage -- is answered exactly
		// like an unknown key, so presenting one reveals nothing about which
		// credential families exist.
		event.locals.apiKeyAuthentication = { state: 'invalid_token' };
		return resolve(event);
	}

	const context: ApiKeyAuthenticationRuntimeContext = { platform: event.platform };
	let authentication: ApiKeyAuthenticationPort | null;
	try {
		authentication = await resolveApiKeyAuthentication(context);
	} catch (error) {
		// Never log the token or its hash: only the failure shape.
		console.error(
			JSON.stringify({
				event: 'api_key_authentication_resolution_failed',
				message: error instanceof Error ? error.name : 'UnknownError'
			})
		);
		authentication = null;
	}
	if (authentication === null) {
		event.locals.apiKeyAuthentication = { state: 'unavailable' };
		return resolve(event);
	}

	try {
		const result = await authentication.authenticate({ token });
		event.locals.apiKeyAuthentication =
			result.outcome === 'authenticated'
				? { state: 'authenticated', principal: result.principal }
				: { state: result.outcome };
	} catch (error) {
		console.error(
			JSON.stringify({
				event: 'api_key_authentication_failed',
				message: error instanceof Error ? error.name : 'UnknownError'
			})
		);
		event.locals.apiKeyAuthentication = { state: 'unavailable' };
	}

	return resolve(event);
};

export const handleSession: Handle = async ({ event, resolve }) => {
	event.locals.principal = null;
	event.locals.instanceMembership = null;
	event.locals.bootstrapped = false;
	event.locals.identityState = 'anonymous';
	if (isSessionExcludedPath(event.url.pathname)) return resolve(event);
	// Bearer mode is exclusive: once an `Authorization` header has been presented
	// on an API key surface, this request has no cookie authority at all.
	if (isCookieSessionSuppressed(event.locals.apiKeyAuthentication)) return resolve(event);

	const cookie = event.cookies.get(SESSION_COOKIE);
	if (!cookie) return resolve(event);
	const unsealed = await unseal(cookie);
	if (!unsealed) {
		event.cookies.delete(SESSION_COOKIE, { path: '/' });
		return resolve(event);
	}
	let session = unsealed.session;
	// Cookie was sealed under a legacy format or the previous key: migrate it
	// onto the active key now so it keeps working after rotation completes,
	// without forcing this operator to sign in again.
	if (unsealed.resealedCookie) {
		event.cookies.set(SESSION_COOKIE, unsealed.resealedCookie, {
			...SESSION_COOKIE_OPTIONS,
			secure: event.url.protocol === 'https:'
		});
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

		// d6e-auth proves identity only. The active local instance member is
		// the sole operator authority, resolved here through the same
		// instance application resolver the handlers use, on both D1 and
		// PostgreSQL. A verified identity with no membership stays
		// authorized for bootstrap and self-profile surfaces only.
		const application = await resolveInstanceApplication({ platform: event.platform });
		if (application === null) {
			event.locals.principal = session.principal;
			event.locals.identityState = 'unavailable';
			return resolve(event);
		}
		const caller = await application.getCurrentMember({ id: session.principal.subject });
		event.locals.principal = session.principal;
		event.locals.bootstrapped = caller.bootstrapped;
		if (caller.member === null) {
			event.locals.identityState = 'no_membership';
		} else if (caller.member.status !== 'active') {
			event.locals.instanceMembership = {
				userId: caller.member.userId,
				role: caller.member.role,
				status: caller.member.status
			};
			event.locals.identityState = 'suspended';
		} else {
			event.locals.instanceMembership = {
				userId: caller.member.userId,
				role: caller.member.role,
				status: caller.member.status
			};
			event.locals.identityState = 'active';
		}
	} catch (error) {
		console.error(
			JSON.stringify({
				event: 'identity_resolution_failed',
				message: error instanceof Error ? error.message : 'unknown error'
			})
		);
		if (error instanceof D6eAuthRejectedError) {
			// The provider explicitly rejected this session -- an expired or
			// revoked refresh/access token -- rather than being unreachable.
			// Clearing the cookie and leaving the anonymous defaults set above in
			// place lets the root layout gate redirect to /auth/login normally,
			// instead of trapping the caller behind a 503 that never recovers
			// until they clear cookies by hand.
			event.cookies.delete(SESSION_COOKIE, { path: '/' });
			event.locals.identityState = 'anonymous';
		} else {
			event.locals.identityState = 'unavailable';
		}
	}

	return resolve(event);
};

export const handle: Handle = sequence(handleLocale, handleApiKeyAuthentication, handleSession);
