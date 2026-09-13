import { problemResponse } from './problem';

export interface AuthorizedIdentityActor {
	id: string;
	name: string;
	email: string;
}

/**
 * Owner-scoped identity authorization for endpoints that never accept or
 * require an organization. The verified d6e-auth principal is the only
 * identity this slice needs; `no_active_organization` is authorized here
 * because durable active-instance-member authorization is enforced by the
 * store, not by organization membership. Anonymous callers are rejected.
 *
 * Authorization is gated on an explicit allow-list of the two intended
 * authenticated states (`authorized`, `no_active_organization`) rather than
 * inferred from `principal !== null`. `unavailable` must fail closed even if
 * a principal happens to be present, since a non-null principal there would
 * otherwise reflect resolution having partially succeeded before failing.
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
	// another key, grant itself an organization, or administer instance members.
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
		(locals.identityState === 'authorized' || locals.identityState === 'no_active_organization') &&
		locals.principal !== null
	) {
		return {
			id: locals.principal.subject,
			name: locals.principal.name,
			email: locals.principal.email
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
