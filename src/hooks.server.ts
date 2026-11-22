import type { Handle, RequestEvent } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { problemResponse } from '$lib/http/problem';
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
	verifyBearerAccessToken,
	type VerifiedBearerAccessToken,
	type VerifiedPrincipal
} from '$lib/server/d6e-auth';
import type { ApiKeyAuthenticationPort } from '$lib/application/api-keys/api-key-authentication';
import { getRequestCallerContext } from '$lib/server/request-caller-membership';
import { bestEffortCaptureMemberDisplay } from '$lib/server/instance-display-capture';
import { localePreferenceRedirect } from '$lib/server/locale-redirect';

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
 * An API path that matches no route answers a JSON problem instead of the
 * HTML not-found page. That page runs the root layout, which sends an
 * anonymous caller to sign-in: a redirect a cross-origin console cannot read
 * (it surfaces as a CORS failure) and a script cannot use. Placed after the
 * console CORS hook, so an allowed console can read the 404.
 */
export const handleUnknownApiRoute: Handle = ({ event, resolve }) => {
	const pathname: string = event.url.pathname;
	if (event.route.id === null && (pathname === '/api' || pathname.startsWith('/api/'))) {
		return problemResponse({
			type: 'urn:signkit:problem:route-not-found',
			title: 'Route not found',
			status: 404,
			detail: 'No API endpoint matches this path.',
			instance: pathname
		});
	}
	return resolve(event);
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
 *   malformed or foreign credential fail closed instead of being ignored.
 */
export function resolveApiKeyBearerMode(
	pathname: string,
	authorization: string | null
): { mode: 'none' } | { mode: 'bearer'; token: string | null } | { mode: 'rejected' } {
	// Management surfaces are checked first. A well-formed API key there is an
	// error, not something to ignore, so it is refused outright.
	if (isApiKeyRejectedPath(pathname) && parseBearerApiKey(authorization) !== null) {
		return { mode: 'rejected' };
	}
	if (!isApiKeyAuthenticatedPath(pathname)) return { mode: 'none' };
	if (!hasAuthorizationHeader(authorization)) return { mode: 'none' };
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
 * Resolves a `signkit_` bearer token into an instance authority. It also selects access-token bearer mode for a
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
 *    selects bearer mode, so a malformed bearer, a foreign credential family,
 *    or an unauthorized key fails closed instead of being treated as absent.
 * 3. Authentication is live key plus active owner plus scopes only, answered
 *    from one durable snapshot. No tenant selector participates.
 *
 * A store that cannot be resolved is `unavailable`, never `absent`: a deployment
 * without a configured database must fail closed rather than silently demote
 * every agent request to anonymous.
 */
export const handleApiKeyAuthentication: Handle = async ({ event, resolve }) => {
	event.locals.apiKeyAuthentication = { state: 'absent' };
	event.locals.accessTokenAuthentication = { state: 'absent' };
	const bearer: BearerMode = resolveBearerMode(
		event.url.pathname,
		event.request.headers.get('authorization')
	);
	if (bearer.mode === 'none') return resolve(event);
	if (bearer.mode === 'access_token') {
		// No API key was presented, so `apiKeyAuthentication` stays `absent` and
		// the authorization helpers treat the verified identity as a human
		// session. `handleSession` verifies the token.
		event.locals.accessTokenAuthentication = { state: 'presented', token: bearer.token };
		return resolve(event);
	}
	if (bearer.mode === 'rejected') {
		// No durable read at all: the refusal follows from where the key was
		// presented, so there is nothing to look up and nothing to disclose.
		event.locals.apiKeyAuthentication = { state: 'rejected_surface' };
		return resolve(event);
	}

	// From here on the request is in bearer mode, whatever the header turned out
	// to contain.
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
 * records it in `locals` for an access-token bearer. Returns the membership only when it is active.
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
 * when it opens a deployment. A bearer request has no per-observation marker
 * that could suppress a database write on every later call, so capture is tied
 * to this one entry read (bootstrap and
 * invitation acceptance still capture immediately on their own).
 */
function isAccessTokenDisplayCaptureRequest(event: RequestEvent): boolean {
	return event.request.method === 'GET' && event.url.pathname === '/api/v1/instance/members/me';
}

/**
 * Access-token bearer mode: the identity comes from the presented d6e-auth
 * access token alone.
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

/**
 * Resolves the operator identity. The only operator credential besides an API
 * key is a d6e-auth access token presented by the console as a bearer; this
 * server keeps no operator cookie session and runs no sign-in of its own.
 */
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
	}
	return resolve(event);
};

export const handle: Handle = sequence(
	handleConsoleCors,
	handleUnknownApiRoute,
	handleLocale,
	handleApiKeyAuthentication,
	handleSession
);
