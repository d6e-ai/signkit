import { problemResponse } from './problem';

export interface AuthorizedIdentityActor {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
}

/**
 * Identity authorization for endpoints that never require an active local
 * membership: bootstrap, self profile, API key management, invitations, and
 * member administration (whose durable store enforces the caller's membership
 * itself). The verified d6e-auth principal is the only identity this slice
 * needs; `no_membership` is authorized here so a verified identity with no
 * membership can still bootstrap the instance or read its own profile.
 * Anonymous callers are rejected.
 *
 * Authorization is gated on an explicit allow-list of the intended
 * authenticated states (`active`, `no_membership`) rather than inferred from
 * `principal !== null`. `suspended` and `unavailable` fail closed even if a
 * principal happens to be present.
 */
export function authorizeIdentityRequest(
	locals: App.Locals,
	instance: string
): AuthorizedIdentityActor | Response {
	// A `signkit_` bearer is refused outright here, never treated as absent and
	// never allowed to ride an accompanying cookie. This branch is load-bearing
	// rather than theoretical: `isApiKeyRejectedPath` classifies every API-key and
	// instance-management path as a rejected surface, so the hooks layer sets
	// `rejected_surface` for exactly these endpoints and suppresses the cookie with
	// it. Refusing again here keeps the guarantee local to the handler, so it holds
	// even if the surface lists change -- an API key must never be able to mint
	// another key or administer instance members.
	if (locals.apiKeyAuthentication.state !== 'absent') {
		return problemResponse({
			type: 'urn:signkit:problem:api-key-not-permitted',
			title: 'API key authentication is not accepted here',
			status: 403,
			detail: 'This endpoint requires an interactive operator session.',
			instance
		});
	}
	if (locals.identityState === 'anonymous') {
		return problemResponse({
			type: 'urn:signkit:problem:authentication-required',
			title: 'Authentication required',
			status: 401,
			detail: 'Sign in before accessing API key resources.',
			instance
		});
	}
	if (
		(locals.identityState === 'active' || locals.identityState === 'no_membership') &&
		locals.principal !== null
	) {
		return {
			id: locals.principal.subject,
			name: locals.principal.name,
			email: locals.principal.email,
			emailVerified: locals.principal.emailVerified === true
		};
	}
	return problemResponse({
		type: 'urn:signkit:problem:identity-unavailable',
		title: 'Identity unavailable',
		status: 503,
		detail: 'Identity could not be verified.',
		instance
	});
}
