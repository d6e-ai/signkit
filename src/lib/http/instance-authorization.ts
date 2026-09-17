import { problemResponse } from './problem';

export interface AuthorizedInstanceActor {
	id: string;
	name: string;
	email: string;
	/**
	 * The caller's local instance role. This is the sole operator authority:
	 * d6e-auth proves identity only, and this role comes from the durable
	 * local instance member row resolved for the verified subject.
	 */
	role: 'owner' | 'admin' | 'member';
}

/**
 * Rejects a request that presented a `signkit_` bearer token on a surface that
 * only accepts an interactive operator session.
 *
 * This is the defense-in-depth half of the two-layer rule. The first layer is the
 * narrow path allowlist in `$lib/navigation/api-key-surface`, which decides where
 * a key is resolved at all; this layer decides what a resolved key may reach.
 * Keeping them independent means widening the allowlist can never by itself hand
 * an API key a mutation or an instance-management command.
 *
 * It answers 403 rather than falling through to the cookie path on purpose. The
 * hooks layer has already refused to resolve a cookie session for this request,
 * so falling through would authorize nothing and report a misleading
 * "authentication required"; and treating a presented bearer as absent is exactly
 * the composition -- attacker bearer plus victim cookie -- that bearer exclusivity
 * exists to prevent.
 */
function apiKeyNotPermitted(locals: App.Locals, instance: string): Response | null {
	if (locals.apiKeyAuthentication.state === 'absent') return null;
	return problemResponse({
		type: 'urn:signkit:problem:api-key-not-permitted',
		title: 'API key authentication is not accepted here',
		status: 403,
		detail: 'This endpoint requires an interactive operator session.',
		instance
	});
}

/**
 * Session-only instance authorization.
 *
 * The active local instance member is the sole operator authority. Requests
 * that accept API keys use {@link authorizeScopedInstanceRequest} instead.
 * This helper still refuses a presented key, which is required for instance
 * administration and any remaining session-only surfaces.
 */
export function authorizeInstanceRequest(
	locals: App.Locals,
	instance: string
): AuthorizedInstanceActor | Response {
	const refused: Response | null = apiKeyNotPermitted(locals, instance);
	if (refused !== null) return refused;

	if (locals.identityState === 'anonymous') {
		return problemResponse({
			type: 'urn:signkit:problem:authentication-required',
			title: 'Authentication required',
			status: 401,
			detail: 'Sign in before accessing instance resources.',
			instance
		});
	}
	if (locals.identityState === 'no_membership') {
		return problemResponse({
			type: 'urn:signkit:problem:instance-membership-required',
			title: 'Instance membership required',
			status: 403,
			detail: 'An active instance membership is required.',
			instance
		});
	}
	if (locals.identityState === 'suspended') {
		return problemResponse({
			type: 'urn:signkit:problem:instance-membership-suspended',
			title: 'Instance membership suspended',
			status: 403,
			detail: 'This instance membership is suspended.',
			instance
		});
	}
	if (
		locals.identityState !== 'active' ||
		locals.principal === null ||
		locals.instanceMembership === null
	) {
		return problemResponse({
			type: 'urn:signkit:problem:identity-unavailable',
			title: 'Identity unavailable',
			status: 503,
			detail: 'Identity and instance authorization could not be verified.',
			instance
		});
	}
	return {
		id: locals.principal.subject,
		name: locals.principal.name,
		email: locals.principal.email,
		role: locals.instanceMembership.role
	};
}

/**
 * Session-only instance owner/admin authorization for resources owned by the
 * instance itself (webhooks, member administration).
 */
export function authorizeInstanceAdminRequest(
	locals: App.Locals,
	instance: string
): AuthorizedInstanceActor | Response {
	const authorized: AuthorizedInstanceActor | Response = authorizeInstanceRequest(locals, instance);
	if (authorized instanceof Response) return authorized;
	if (authorized.role !== 'owner' && authorized.role !== 'admin') {
		return problemResponse({
			type: 'urn:signkit:problem:instance-admin-required',
			title: 'Instance administration forbidden',
			status: 403,
			detail: 'This resource can be managed only by instance owners and admins.',
			instance
		});
	}
	return authorized;
}
