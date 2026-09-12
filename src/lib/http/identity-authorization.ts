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
