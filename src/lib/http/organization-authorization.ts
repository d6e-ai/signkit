import { problemResponse } from './problem';

export interface AuthorizedRequestActor {
	id: string;
	name: string;
	email: string;
	organizationId: string;
	organizationName: string;
	/**
	 * The caller's role in the authorized organization, as reported by the
	 * verified d6e-auth membership for this request. This is live d6e authority,
	 * not local instance membership, and the two must never be substituted for one
	 * another: a SignKit instance `owner` is not thereby an organization `owner`.
	 */
	organizationRole: 'owner' | 'admin' | 'member';
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
 * Session-only organization authorization.
 *
 * Every mutation and every endpoint that has not deliberately opted into API key
 * access uses this. A resolved API key is refused outright, so machine actors
 * cannot reach the envelope mutation commands in this slice -- which is required,
 * not merely conservative: the completion artifact verifier pins
 * `envelope.created`, `envelope.ready`, `envelope.fields_placed`,
 * `envelope.sent`, and `envelope.voided` to `actor_type = 'user'`, and
 * `actor_type` is not part of those events' hash preimage, so admitting a machine
 * actor would either falsify the audit chain or make every affected envelope fail
 * completion artifact publication.
 */
export function authorizeOrganizationRequest(
	locals: App.Locals,
	instance: string
): AuthorizedRequestActor | Response {
	const refused: Response | null = apiKeyNotPermitted(locals, instance);
	if (refused !== null) return refused;

	if (locals.identityState === 'anonymous') {
		return problemResponse({
			type: 'urn:signkit:problem:authentication-required',
			title: 'Authentication required',
			status: 401,
			detail: 'Sign in before accessing organization resources.',
			instance
		});
	}
	if (locals.identityState === 'no_active_organization') {
		return problemResponse({
			type: 'urn:signkit:problem:organization-required',
			title: 'Active organization required',
			status: 403,
			detail: 'An active organization membership is required.',
			instance
		});
	}
	if (
		locals.identityState !== 'authorized' ||
		locals.principal === null ||
		locals.organizationId === null
	) {
		return problemResponse({
			type: 'urn:signkit:problem:identity-unavailable',
			title: 'Identity unavailable',
			status: 503,
			detail: 'Identity and organization authorization could not be verified.',
			instance
		});
	}
	const membership = locals.memberships.find(
		(candidate) => candidate.organization.id === locals.organizationId
	);
	if (!membership) {
		return problemResponse({
			type: 'urn:signkit:problem:identity-unavailable',
			title: 'Identity unavailable',
			status: 503,
			detail: 'The selected organization membership could not be verified.',
			instance
		});
	}
	return {
		id: locals.principal.subject,
		name: locals.principal.name,
		email: locals.principal.email,
		organizationId: locals.organizationId,
		organizationName: membership.organization.name,
		organizationRole: membership.role
	};
}

/**
 * The session-selected organization this caller currently administers, or null.
 *
 * This is the organization-side de-escalation scope for grant revocation, and it
 * is deliberately derived from `locals` alone: the organization is whichever one
 * the verified session already resolved, and the role comes from that same
 * verified d6e-auth membership. No request field participates, so an
 * identity-only caller can never name an organization they have no authority
 * over -- which is the whole reason this returns a value rather than accepting
 * one.
 *
 * Returns null for an anonymous, unavailable, or organization-less session, and
 * for a caller whose role in the selected organization is merely `member`. It
 * also returns null whenever a `signkit_` bearer was presented, so an API key can
 * never acquire organization administration authority.
 */
export function resolveOrganizationAdminScope(locals: App.Locals): string | null {
	if (locals.apiKeyAuthentication.state !== 'absent') return null;
	if (locals.identityState !== 'authorized') return null;
	if (locals.principal === null || locals.organizationId === null) return null;
	const membership = locals.memberships.find(
		(candidate) => candidate.organization.id === locals.organizationId
	);
	if (!membership) return null;
	return membership.role === 'owner' || membership.role === 'admin' ? locals.organizationId : null;
}
