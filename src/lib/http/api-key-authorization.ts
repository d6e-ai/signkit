import type { ApiKeyScope } from '$lib/security/api-key';
import { authorizeInstanceRequest, type AuthorizedInstanceActor } from './instance-authorization';
import { problemResponse } from './problem';

/**
 * An instance actor that may have arrived by either authority.
 *
 * `id` is the stable actor identifier for provenance: the d6e-auth subject for a
 * session, the API key id for a key. The two namespaces must never be conflated
 * -- an API key id is a SignKit-minted UUIDv7 and is not a user -- which is why
 * `authority` is carried explicitly rather than inferred from the shape of `id`.
 *
 * `createdByUserId` is the instance member envelopes are attributed to: the
 * subject for a session, the key owner's user id for a key. The audit actor
 * stays (`id`, `agent`) for keys.
 *
 * There is deliberately no `name` or `email` on key actors. A machine actor has
 * no human identity, and the only consumer of those fields is draft commit Git
 * attribution, which remains session-only in this slice. Omitting them makes it a
 * type error, not a runtime surprise, to reach for human identity on a path an
 * API key can travel.
 */
export interface AuthorizedApiActor {
	authority: 'session' | 'api_key';
	id: string;
	createdByUserId: string;
	name?: string;
	email?: string;
}

/**
 * RFC 6750 asks for a `WWW-Authenticate` challenge on a 401. It deliberately
 * carries no `error` parameter: encoding `invalid_token` would re-expose the very
 * distinction the opaque 401 exists to hide, and no realm, scope, or detail about
 * the presented credential appears here either.
 */
const OPAQUE_BEARER_CHALLENGE: HeadersInit = { 'www-authenticate': 'Bearer' };

function authenticationRequired(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:api-key-authentication-required',
			title: 'API key authentication required',
			status: 401,
			detail: 'A live SignKit API key is required for this request.',
			instance
		},
		OPAQUE_BEARER_CHALLENGE
	);
}

function insufficientScope(instance: string, requiredScope: ApiKeyScope): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:api-key-insufficient-scope',
			title: 'Insufficient API key scope',
			status: 403,
			detail: `This request requires the ${requiredScope} scope.`,
			instance
		},
		// Naming the required scope tells the holder only what the endpoint they
		// just called needs. It discloses nothing about the key itself.
		{ 'www-authenticate': `Bearer error="insufficient_scope", scope="${requiredScope}"` }
	);
}

function rateLimited(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:api-key-rate-limited',
		title: 'API key rate limit exceeded',
		status: 429,
		detail: 'This API key has exceeded its durable per-window request limit.',
		instance
	});
}

function apiKeyNotPermitted(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:api-key-not-permitted',
		title: 'API key authentication is not accepted here',
		status: 403,
		detail: 'This endpoint requires an interactive operator session.',
		instance
	});
}

function authenticationUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:api-key-authentication-unavailable',
		title: 'API key authentication unavailable',
		status: 503,
		detail: 'The API key authority could not be resolved.',
		instance
	});
}

/**
 * Authorizes an instance request that accepts either an operator session or
 * an API key carrying `requiredScope`.
 *
 * Bearer mode is exclusive and checked first: if anything other than `absent` is
 * present, this function never consults the session, so a failed key cannot fall
 * back to a cookie and a cookie cannot be upgraded by a failed key.
 *
 * Outcome ordering within bearer mode is deliberate and is the whole opacity
 * design:
 *
 * - an unknown, revoked, or expired key and a suspended or missing owner share
 *   one opaque 401, so the endpoint is not an existence or status oracle;
 * - insufficient scope is a separate 403, evaluated after authentication, so
 *   scope never leaks key validity;
 * - integrity drift and an unresolvable store are 503, never a downgrade to
 *   unauthenticated.
 *
 * `requiredScope` applies only to API key actors. A session actor is an active
 * local instance member and is not scope-limited; scopes are a property of
 * issued credentials, not of people.
 */
/**
 * Refuses a bearer state this function does not handle.
 *
 * The `never` parameter makes an unhandled state a compile error, so this can
 * only run if the type is bypassed at a boundary. It answers unavailable rather
 * than falling through to the cookie session, because an unclassifiable bearer
 * must fail closed, not be treated as absent.
 */
function unhandledBearerState(_state: never, instance: string): Response {
	console.error(JSON.stringify({ event: 'api_key_authorization_unhandled_state' }));
	return authenticationUnavailable(instance);
}

export function authorizeScopedInstanceRequest(
	locals: App.Locals,
	instance: string,
	requiredScope: ApiKeyScope
): AuthorizedApiActor | Response {
	const authentication: App.Locals['apiKeyAuthentication'] = locals.apiKeyAuthentication;

	// Bearer mode returns from inside this block in every case. It deliberately
	// does not fall through to the session path below: a future state added to
	// `ApiKeyAuthenticationState` without a branch here would otherwise silently
	// hand a presented bearer to the cookie session, which is the exact
	// composition bearer exclusivity exists to prevent. The `never` guard at the
	// end makes that a compile error, and refuses at runtime if it is ever
	// bypassed.
	if (authentication.state !== 'absent') {
		switch (authentication.state) {
			case 'rejected_surface':
				// Unreachable while the two path lists stay disjoint, but a read surface
				// must still refuse rather than fall through to the cookie if they ever
				// overlap.
				return apiKeyNotPermitted(instance);
			case 'invalid_token':
				return authenticationRequired(instance);
			case 'rate_limited':
				return rateLimited(instance);
			case 'integrity_error':
			case 'unavailable':
				return authenticationUnavailable(instance);
			case 'authenticated': {
				if (!authentication.principal.scopes.includes(requiredScope)) {
					return insufficientScope(instance, requiredScope);
				}
				return {
					authority: 'api_key',
					id: authentication.principal.apiKeyId,
					createdByUserId: authentication.principal.ownerUserId
				};
			}
			default:
				return unhandledBearerState(authentication, instance);
		}
	}

	const authorized: AuthorizedInstanceActor | Response = authorizeInstanceRequest(locals, instance);
	if (authorized instanceof Response) return authorized;
	return {
		authority: 'session',
		id: authorized.id,
		createdByUserId: authorized.id,
		name: authorized.name,
		email: authorized.email
	};
}
