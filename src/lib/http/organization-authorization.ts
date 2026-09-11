import { problemResponse } from './problem';

export interface AuthorizedRequestActor {
	id: string;
	name: string;
	email: string;
	organizationId: string;
	organizationName: string;
}

export function authorizeOrganizationRequest(
	locals: App.Locals,
	instance: string
): AuthorizedRequestActor | Response {
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
		organizationName: membership.organization.name
	};
}
