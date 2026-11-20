import type { Handle, RequestEvent } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { cookieName, getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import {
	resolveApiKeyAuthentication,
	type ApiKeyAuthenticationRuntimeContext
} from '$lib/application/api-keys/api-key-authentication-runtime';
import { resolveInstanceApplication } from '$lib/application/instance/instance-runtime';
import { isApiKeyAuthenticatedPath, isApiKeyRejectedPath } from '$lib/navigation/api-key-surface';
import { consoleCorsSurface, isOperatorApiPath } from '$lib/navigation/operator-api-surface';
import { isRecipientSurfacePath } from '$lib/navigation/recipient-surface';
import { parseBearerAccessToken } from '$lib/security/access-token-bearer';
import { hasAuthorizationHeader, parseBearerApiKey } from '$lib/security/api-key';
import {
	consoleCorsPreflightResponse,
	isConsoleCorsMethod,
	resolveConsoleOrigins,
	withConsoleCorsHeaders
} from '$lib/http/console-cors';
import {
	D6eAuthRejectedError,
	refresh,
	verifyAccessToken,
	verifyBearerAccessToken,
	type VerifiedBearerAccessToken,
	type VerifiedPrincipal
} from '$lib/server/d6e-auth';
import type { ApiKeyAuthenticationPort } from '$lib/application/api-keys/api-key-authentication';
import { getRequestCallerContext } from '$lib/server/request-caller-membership';
import { bestEffortCaptureMemberDisplay } from '$lib/server/instance-display-capture';
import { localePreferenceRedirect } from '$lib/server/locale-redirect';
import {
	SESSION_COOKIE,
	SESSION_COOKIE_OPTIONS,
	isExpiring,
	seal,
	unseal
} from '$lib/server/session';

type InstanceMembership = NonNullable<App.Locals['instanceMembership']>;

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

export const handleLocale: Handle = ({ event, resolve }) => {
	if (isLocaleExcludedPath(event.url.pathname)) return resolve(event);
	const preferenceRedirect = localePreferenceRedirect(
		event.url,
		event.request,
		event.cookies.get(cookieName)
	);
	if (preferenceRedirect) return preferenceRedirect;

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
 * Cross-origin access for operator consoles listed in `SIGNKIT_CONSOLE_ORIGINS`.
 *
 * Runs first so a preflight is answered before any credential handling: a
 * preflight never carries credentials and must not reach a route. Only the
 * operator API surface (every method it uses) and public discovery (`GET`) are
 * eligible; the recipient surface, completion artifacts, and system endpoints
 * never receive a CORS header whatever origin asks.
 *
 * Credentialed CORS is never allowed. The console authenticates with an
 * explicit d6e-auth access token, so browsers never attach this deployment's
 * cookie to a cross-origin call, and a request that is not allowed simply gets
 * no CORS headers -- the browser then withholds the response from the page.
 * SvelteKit's own CSRF origin check still applies first: it refuses
 * cross-origin form content types (`application/x-www-form-urlencoded`,
 * `multipart/form-data`, `text/plain`), which no operator endpoint accepts, and
 * leaves the JSON and raw-body API calls a console makes to this policy. The
 * explicit same-origin checks of the recipient signing commands are unaffected
 * because those paths are never eligible.
 */
export const handleConsoleCors: Handle = async ({ event, resolve }) => {
	const surface = consoleCorsSurface(event.url.pathname);
	if (surface === null) return resolve(event);
	const origins: ReadonlySet<string> = resolveConsoleOrigins(event.platform);
	if (origins.size === 0) return resolve(event);

	const origin: string | null = event.request.headers.get('origin');
	const allowedOrigin: string | null = origin !== null && origins.has(origin) ? origin : null;
	const requestedMethod: string | null = event.request.headers.get('access-control-request-method');
	if (event.request.method === 'OPTIONS' && requestedMethod !== null) {
		if (allowedOrigin !== null && isConsoleCorsMethod(surface, requestedMethod)) {
			return consoleCorsPreflightResponse(allowedOrigin, surface);
		}
		// A refused preflight falls through to normal routing, which has no
		// OPTIONS handler and answers 405 without any CORS header.
		return withConsoleCorsHeaders(await resolve(event), null);
	}

	const response: Response = await resolve(event);
	return withConsoleCorsHeaders(
		response,
		allowedOrigin !== null && isConsoleCorsMethod(surface, event.request.method)
			? allowedOrigin
			: null
	);
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

export type BearerMode =
	ReturnType<typeof resolveApiKeyBearerMode> | { mode: 'access_token'; token: string };

/**
 * The bearer mode for this request across both credential families.
 *
 * A d6e-auth access token -- `Bearer ` and a compact JWS, never starting with
 * `signkit_` -- is recognized only on the operator API surface, and is checked
 * before the API key rules so a console token on an envelope route is not
 * answered as an unknown API key. Everything else, including every `signkit_`
 * value and every opaque non-JWT bearer, is decided by
 * {@link resolveApiKeyBearerMode} exactly as before access tokens were
 * accepted.
 */
export function resolveBearerMode(pathname: string, authorization: string | null): BearerMode {
	if (isOperatorApiPath(pathname)) {
		const accessToken: string | null = parseBearerAccessToken(authorization);
		if (accessToken !== null) return { mode: 'access_token', token: accessToken };
	}
	return resolveApiKeyBearerMode(pathname, authorization);
}

/**
 * Whether the cookie session must be left unresolved for this request.
 *
 * True for every bearer-mode state, including the failing ones. Resolving a
 * cookie alongside a presented bearer would reintroduce exactly the composition
 * this design forbids: an attacker-supplied bearer riding a victim's session.
 */
export function isCookieSessionSuppressed(
	authentication: App.Locals['apiKeyAuthentication'],
	accessToken: App.Locals['accessTokenAuthentication'] = { state: 'absent' }
): boolean {
	return authentication.state !== 'absent' || accessToken.state !== 'absent';
}

/**
 * Resolves a `signkit_` bearer token into an instance authority, before any
 * cookie session is considered. It also selects access-token bearer mode for a
 * d6e-auth access token on the operator API surface (see
 * {@link resolveBearerMode}); that token is verified by {@link handleSession}.
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
	event.locals.accessTokenAuthentication = { state: 'absent' };
	const bearer: BearerMode = resolveBearerMode(
		event.url.pathname,
		event.request.headers.get('authorization')
	);
	if (bearer.mode === 'cookie') return resolve(event);
	if (bearer.mode === 'access_token') {
		// No API key was presented, so `apiKeyAuthentication` stays `absent` and
		// the authorization helpers treat the verified identity as a human
		// session. `handleSession` verifies the token and never reads the cookie.
		event.locals.accessTokenAuthentication = { state: 'presented', token: bearer.token };
		return resolve(event);
	}
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

/**
 * Resolves the local instance membership for a verified d6e-auth identity and
 * records it in `locals`, identically for the cookie session and an
 * access-token bearer. Returns the membership only when it is active.
 *
 * d6e-auth proves identity only. The active local instance member is the sole
 * operator authority, resolved here through the same instance application
 * resolver the handlers use, on both D1 and PostgreSQL. A verified identity
 * with no membership stays authorized for bootstrap and self-profile surfaces
 * only. Throws when membership cannot be read; callers fail closed.
 */
async function resolveMemberIdentity(
	event: RequestEvent,
	principal: VerifiedPrincipal
): Promise<InstanceMembership | null> {
	const application = await resolveInstanceApplication({ platform: event.platform });
	if (application === null) {
		event.locals.principal = principal;
		event.locals.identityState = 'unavailable';
		return null;
	}
	const caller = await getRequestCallerContext(event.locals, principal.subject, () =>
		application.getCurrentMember({ id: principal.subject })
	);
	event.locals.principal = principal;
	event.locals.bootstrapped = caller.bootstrapped;
	if (caller.member === null) {
		event.locals.identityState = 'no_membership';
		return null;
	}
	const membership: InstanceMembership = {
		userId: caller.member.userId,
		role: caller.member.role,
		status: caller.member.status
	};
	event.locals.instanceMembership = membership;
	if (caller.member.status !== 'active') {
		event.locals.identityState = 'suspended';
		return null;
	}
	event.locals.identityState = 'active';
	return membership;
}

/**
 * The only request on which an access-token bearer records the member display
 * snapshot from its own verified claims: the self-profile read a console makes
 * when it opens a deployment. Unlike the cookie session, a bearer request has
 * no per-observation marker that could suppress a sealing and database write on
 * every later call, so capture is tied to this one entry read (bootstrap and
 * invitation acceptance still capture immediately on their own).
 */
function isAccessTokenDisplayCaptureRequest(event: RequestEvent): boolean {
	return event.request.method === 'GET' && event.url.pathname === '/api/v1/instance/members/me';
}

/**
 * Access-token bearer mode: the identity comes from the presented d6e-auth
 * access token alone. The cookie jar is neither read nor written -- not even
 * cleared on rejection -- because this request never had a cookie authority.
 */
async function resolveAccessTokenSession(event: RequestEvent, token: string): Promise<void> {
	let verified: VerifiedBearerAccessToken;
	try {
		verified = await verifyBearerAccessToken(token);
	} catch (error: unknown) {
		const rejected: boolean = error instanceof D6eAuthRejectedError;
		// Never log the token or anything derived from it: only the failure shape.
		console.error(
			JSON.stringify({
				event: 'access_token_bearer_verification_failed',
				outcome: rejected ? 'rejected' : 'unavailable',
				message: error instanceof Error ? error.name : 'UnknownError'
			})
		);
		event.locals.accessTokenAuthentication = { state: rejected ? 'rejected' : 'unavailable' };
		event.locals.identityState = rejected ? 'anonymous' : 'unavailable';
		return;
	}
	event.locals.accessTokenAuthentication = { state: 'verified', observedAt: verified.observedAt };

	try {
		const active: InstanceMembership | null = await resolveMemberIdentity(
			event,
			verified.principal
		);
		if (
			active !== null &&
			verified.observedAt !== null &&
			isAccessTokenDisplayCaptureRequest(event)
		) {
			try {
				await bestEffortCaptureMemberDisplay({
					platform: event.platform,
					accessTokenObservedAt: verified.observedAt,
					memberUserId: active.userId,
					principal: verified.principal
				});
			} catch {
				// Display capture never fails identity resolution.
			}
		}
	} catch (error: unknown) {
		console.error(
			JSON.stringify({
				event: 'identity_resolution_failed',
				message: error instanceof Error ? error.message : 'unknown error'
			})
		);
		event.locals.principal = null;
		event.locals.instanceMembership = null;
		event.locals.identityState = 'unavailable';
	}
}

export const handleSession: Handle = async ({ event, resolve }) => {
	event.locals.requestCallerContexts = undefined;
	event.locals.principal = null;
	event.locals.instanceMembership = null;
	event.locals.bootstrapped = false;
	event.locals.identityState = 'anonymous';
	if (isSessionExcludedPath(event.url.pathname)) return resolve(event);
	const accessToken: App.Locals['accessTokenAuthentication'] =
		event.locals.accessTokenAuthentication;
	if (accessToken.state === 'presented') {
		await resolveAccessTokenSession(event, accessToken.token);
		return resolve(event);
	}
	// Bearer mode is exclusive: once an `Authorization` header has been presented
	// on an API key surface, or an access token on the operator surface, this
	// request has no cookie authority at all.
	if (isCookieSessionSuppressed(event.locals.apiKeyAuthentication, accessToken)) {
		return resolve(event);
	}

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
				principal: renewed.principal,
				profileObservedAt: new Date().toISOString()
			};
			event.cookies.set(SESSION_COOKIE, await seal(session), {
				...SESSION_COOKIE_OPTIONS,
				secure: event.url.protocol === 'https:'
			});
		} else {
			session.principal = await verifyAccessToken(session.accessToken);
		}

		const active: InstanceMembership | null = await resolveMemberIdentity(event, session.principal);
		if (active !== null) {
			try {
				session =
					(await bestEffortCaptureMemberDisplay({
						cookies: event.cookies,
						url: event.url,
						platform: event.platform,
						session,
						memberUserId: active.userId,
						principal: session.principal
					})) ?? session;
			} catch {
				// Display capture never fails identity resolution.
			}
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

export const handle: Handle = sequence(
	handleConsoleCors,
	handleLocale,
	handleApiKeyAuthentication,
	handleSession
);
