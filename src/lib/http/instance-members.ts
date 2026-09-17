import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import type { InstanceApplicationPort } from '$lib/application/instance/instance-service';
import {
	InvalidInstanceMemberRequestError,
	type InstanceMemberApplicationPort,
	type ListInstanceMembersResult,
	type SetInstanceMemberRoleResult,
	type SetInstanceMemberStatusResult
} from '$lib/application/instance-members/instance-member-service';
import {
	DEFAULT_INSTANCE_MEMBER_LIST_LIMIT,
	MAX_INSTANCE_MEMBER_LIST_LIMIT,
	type InstanceCallerContext
} from '$lib/ports/instance-store';
import {
	acceptsJson,
	readJsonBody,
	validationErrors,
	type JsonBodyResult
} from './bounded-json-body';
import { authorizeIdentityRequest, type AuthorizedIdentityActor } from './identity-authorization';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_MUTATION_BODY_BYTES: number = 1024;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type InstanceApplicationResolver = (
	context: ResolverContext
) => InstanceApplicationPort | null | Promise<InstanceApplicationPort | null>;

export type InstanceMemberApplicationResolver = (
	context: ResolverContext
) => InstanceMemberApplicationPort | null | Promise<InstanceMemberApplicationPort | null>;

export interface InstanceMemberHttpHandlers {
	list: RequestHandler;
	setRole: RequestHandler;
	setStatus: RequestHandler;
}

const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');

const listInstanceMembersSchema: ZodType<{ cursor?: string; limit: number }> = z
	.object({
		cursor: z.string().min(1).max(200).optional(),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(MAX_INSTANCE_MEMBER_LIST_LIMIT)
			.default(DEFAULT_INSTANCE_MEMBER_LIST_LIMIT)
	})
	.strict();

const setInstanceMemberRoleSchema: ZodType<{ role: 'owner' | 'admin' | 'member' }> = z
	.object({
		role: z.enum(['owner', 'admin', 'member'])
	})
	.strict();

const setInstanceMemberStatusSchema: ZodType<{ status: 'active' | 'suspended' }> = z
	.object({
		status: z.enum(['active', 'suspended'])
	})
	.strict();

export function createInstanceMemberMeHandler(
	resolveApplication: InstanceApplicationResolver
): RequestHandler {
	return async ({ locals, platform, url }): Promise<Response> => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		let application: InstanceApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'instance_member_me_resolution_failed',
					message: error instanceof Error ? error.message : 'Unknown error'
				})
			);
			application = null;
		}
		if (application === null) {
			return problemResponse({
				type: 'urn:signkit:problem:persistence-unavailable',
				title: 'Instance persistence unavailable',
				status: 503,
				detail: 'The durable instance store is not configured for this deployment.',
				instance: url.pathname
			});
		}

		try {
			const context: InstanceCallerContext = await application.getCurrentMember({
				id: authorized.id
			});
			return new Response(JSON.stringify(context), {
				status: 200,
				headers: {
					'cache-control': 'no-store',
					'content-type': 'application/json'
				}
			});
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'instance_member_me_failed',
					message: error instanceof Error ? error.message : 'Unknown error'
				})
			);
			return problemResponse({
				type: 'urn:signkit:problem:service-unavailable',
				title: 'Instance service unavailable',
				status: 503,
				detail: 'The caller membership could not be retrieved.',
				instance: url.pathname
			});
		}
	};
}

function validationFailed(
	instance: string,
	detail: string,
	errors: readonly ProblemValidationError[]
): Response {
	return problemResponse({
		type: 'urn:signkit:problem:validation-failed',
		title: 'Request validation failed',
		status: 400,
		detail,
		instance,
		errors
	});
}

function idempotencyKeyRequired(instance: string, issues: readonly ZodIssue[]): Response {
	return problemResponse({
		type: 'urn:signkit:problem:idempotency-key-required',
		title: 'Valid Idempotency-Key required',
		status: 400,
		detail: 'POST requests require one non-empty visible-ASCII Idempotency-Key header.',
		instance,
		errors: validationErrors(issues)
	});
}

function unsupportedMediaType(instance: string, detail: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:unsupported-media-type',
		title: 'Unsupported media type',
		status: 415,
		detail,
		instance
	});
}

function invalidJson(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:invalid-json',
		title: 'Invalid JSON',
		status: 400,
		detail: 'The request body must be valid JSON.',
		instance
	});
}

function bodyTooLarge(instance: string, maxBytes: number): Response {
	return problemResponse({
		type: 'urn:signkit:problem:request-body-too-large',
		title: 'Request body too large',
		status: 413,
		detail: `The request body must not exceed ${maxBytes} bytes.`,
		instance
	});
}

function persistenceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:persistence-unavailable',
		title: 'Instance member persistence unavailable',
		status: 503,
		detail: 'The durable instance store is not configured for this deployment.',
		instance
	});
}

function serviceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-member-service-unavailable',
		title: 'Instance member service unavailable',
		status: 503,
		detail: 'The instance member operation could not be completed.',
		instance
	});
}

function forbidden(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-member-forbidden',
		title: 'Instance member actor not permitted',
		status: 403,
		detail: 'The authenticated caller is not permitted to administer this instance member.',
		instance
	});
}

function memberSuspended(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-member-suspended',
		title: 'Instance member actor suspended',
		status: 403,
		detail: 'The authenticated caller is not an active instance member.',
		instance
	});
}

function roleNotPermitted(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-member-role-not-permitted',
		title: 'Instance member role not permitted',
		status: 403,
		detail: 'The authenticated caller may not grant the requested role.',
		instance
	});
}

function memberNotFound(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-member-not-found',
		title: 'Instance member not found',
		status: 404,
		detail: 'No instance member was found for the requested identifier.',
		instance
	});
}

function lastActiveOwner(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-member-last-active-owner',
		title: 'Instance owner floor would be violated',
		status: 409,
		detail: 'This change would leave the instance with no active owner.',
		instance
	});
}

function cannotTargetSelf(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-member-cannot-target-self',
		title: 'Instance member cannot target self',
		status: 409,
		detail: 'The authenticated caller may not perform this operation on their own membership.',
		instance
	});
}

function idempotencyConflict(instance: string, detail: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-member-idempotency-conflict',
		title: 'Idempotency key conflict',
		status: 409,
		detail,
		instance
	});
}

function integrityError(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-member-integrity-error',
		title: 'Instance member integrity check failed',
		status: 503,
		detail: 'The instance member command could not prove a consistent state.',
		instance
	});
}

/**
 * Both resolver and per-request operation failures may wrap store or provider
 * internals that could echo credentials or request-derived content, so only
 * the error's name is ever logged, never its message.
 */
function operationErrorName(error: unknown): string {
	return error instanceof Error ? error.name : 'unknown_error';
}

async function resolveMemberApplicationOrProblem(
	resolveApplication: InstanceMemberApplicationResolver,
	context: ResolverContext,
	instance: string,
	event: string
): Promise<InstanceMemberApplicationPort | Response> {
	let application: InstanceMemberApplicationPort | null;
	try {
		application = await resolveApplication(context);
	} catch (error: unknown) {
		console.error(JSON.stringify({ event, message: operationErrorName(error) }));
		application = null;
	}
	return application === null ? persistenceUnavailable(instance) : application;
}

/**
 * Creates the instance member administration handlers: cursor-paginated
 * list, and per-target-user role/status mutations. Distinct from
 * {@link createInstanceMemberMeHandler} above, which stays scoped to the
 * caller's own membership lookup and is never touched by this factory.
 */
export function createInstanceMemberHttpHandlers(
	resolveApplication: InstanceMemberApplicationResolver
): InstanceMemberHttpHandlers {
	const list: RequestHandler = async ({ locals, platform, url }): Promise<Response> => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		const query = listInstanceMembersSchema.safeParse(Object.fromEntries(url.searchParams));
		if (!query.success) {
			return validationFailed(
				url.pathname,
				'The instance member list query did not match the required schema.',
				validationErrors(query.error.issues)
			);
		}

		const application: InstanceMemberApplicationPort | Response =
			await resolveMemberApplicationOrProblem(
				resolveApplication,
				{ platform },
				url.pathname,
				'instance_member_list_resolution_failed'
			);
		if (application instanceof Response) return application;

		try {
			const result: ListInstanceMembersResult = await application.list(
				{ id: authorized.id },
				{ cursor: query.data.cursor ?? null, limit: query.data.limit }
			);
			if (result.outcome === 'forbidden') return forbidden(url.pathname);
			if (result.outcome === 'member_suspended') return memberSuspended(url.pathname);
			return new Response(
				JSON.stringify({ members: result.page.items, nextCursor: result.page.nextCursor }),
				{
					status: 200,
					headers: { 'cache-control': 'no-store', 'content-type': 'application/json' }
				}
			);
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'instance_member_list_failed', message: operationErrorName(error) })
			);
			return serviceUnavailable(url.pathname);
		}
	};

	const setRole: RequestHandler = async ({
		locals,
		params,
		platform,
		request,
		url
	}): Promise<Response> => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		const targetUserId: string = params.userId ?? '';

		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success) {
			return idempotencyKeyRequired(url.pathname, idempotencyKey.error.issues);
		}
		if (!acceptsJson(request)) {
			return unsupportedMediaType(
				url.pathname,
				'Instance member role changes require an application/json request body.'
			);
		}

		const body: JsonBodyResult = await readJsonBody(request, MAX_MUTATION_BODY_BYTES);
		if (!body.ok) {
			return body.reason === 'too_large'
				? bodyTooLarge(url.pathname, MAX_MUTATION_BODY_BYTES)
				: invalidJson(url.pathname);
		}

		const parsed = setInstanceMemberRoleSchema.safeParse(body.value);
		if (!parsed.success) {
			return validationFailed(
				url.pathname,
				'The instance member role change request did not match the required schema.',
				validationErrors(parsed.error.issues)
			);
		}

		const application: InstanceMemberApplicationPort | Response =
			await resolveMemberApplicationOrProblem(
				resolveApplication,
				{ platform },
				url.pathname,
				'instance_member_set_role_resolution_failed'
			);
		if (application instanceof Response) return application;

		try {
			const result: SetInstanceMemberRoleResult = await application.setRole(
				{ id: authorized.id },
				{ idempotencyKey: idempotencyKey.data, targetUserId, role: parsed.data.role }
			);
			return setRoleResponse(result, url.pathname);
		} catch (error: unknown) {
			if (error instanceof InvalidInstanceMemberRequestError) {
				return validationFailed(url.pathname, error.message, [
					{ path: '$', message: error.message }
				]);
			}
			console.error(
				JSON.stringify({
					event: 'instance_member_set_role_failed',
					message: operationErrorName(error)
				})
			);
			return serviceUnavailable(url.pathname);
		}
	};

	const setStatus: RequestHandler = async ({
		locals,
		params,
		platform,
		request,
		url
	}): Promise<Response> => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		const targetUserId: string = params.userId ?? '';

		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success) {
			return idempotencyKeyRequired(url.pathname, idempotencyKey.error.issues);
		}
		if (!acceptsJson(request)) {
			return unsupportedMediaType(
				url.pathname,
				'Instance member status changes require an application/json request body.'
			);
		}

		const body: JsonBodyResult = await readJsonBody(request, MAX_MUTATION_BODY_BYTES);
		if (!body.ok) {
			return body.reason === 'too_large'
				? bodyTooLarge(url.pathname, MAX_MUTATION_BODY_BYTES)
				: invalidJson(url.pathname);
		}

		const parsed = setInstanceMemberStatusSchema.safeParse(body.value);
		if (!parsed.success) {
			return validationFailed(
				url.pathname,
				'The instance member status change request did not match the required schema.',
				validationErrors(parsed.error.issues)
			);
		}

		const application: InstanceMemberApplicationPort | Response =
			await resolveMemberApplicationOrProblem(
				resolveApplication,
				{ platform },
				url.pathname,
				'instance_member_set_status_resolution_failed'
			);
		if (application instanceof Response) return application;

		try {
			const result: SetInstanceMemberStatusResult = await application.setStatus(
				{ id: authorized.id },
				{ idempotencyKey: idempotencyKey.data, targetUserId, status: parsed.data.status }
			);
			return setStatusResponse(result, url.pathname);
		} catch (error: unknown) {
			if (error instanceof InvalidInstanceMemberRequestError) {
				return validationFailed(url.pathname, error.message, [
					{ path: '$', message: error.message }
				]);
			}
			console.error(
				JSON.stringify({
					event: 'instance_member_set_status_failed',
					message: operationErrorName(error)
				})
			);
			return serviceUnavailable(url.pathname);
		}
	};

	return { list, setRole, setStatus };
}

function setRoleResponse(result: SetInstanceMemberRoleResult, instance: string): Response {
	if (result.outcome === 'updated' || result.outcome === 'replayed') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(
			JSON.stringify({
				member: result.member,
				appliedAt: result.appliedAt,
				revokedInvitationCount: result.revokedInvitationCount
			}),
			{ status: 200, headers }
		);
	}
	if (result.outcome === 'forbidden') return forbidden(instance);
	if (result.outcome === 'member_suspended') return memberSuspended(instance);
	if (result.outcome === 'role_not_permitted') return roleNotPermitted(instance);
	if (result.outcome === 'member_not_found') return memberNotFound(instance);
	if (result.outcome === 'last_active_owner') return lastActiveOwner(instance);
	if (result.outcome === 'idempotency_conflict') {
		return idempotencyConflict(
			instance,
			'The Idempotency-Key was already used for a different instance member role change request.'
		);
	}
	return integrityError(instance);
}

function setStatusResponse(result: SetInstanceMemberStatusResult, instance: string): Response {
	if (result.outcome === 'updated' || result.outcome === 'replayed') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(
			JSON.stringify({
				member: result.member,
				appliedAt: result.appliedAt,
				revokedInvitationCount: result.revokedInvitationCount
			}),
			{ status: 200, headers }
		);
	}
	if (result.outcome === 'forbidden') return forbidden(instance);
	if (result.outcome === 'member_suspended') return memberSuspended(instance);
	if (result.outcome === 'member_not_found') return memberNotFound(instance);
	if (result.outcome === 'last_active_owner') return lastActiveOwner(instance);
	if (result.outcome === 'cannot_target_self') return cannotTargetSelf(instance);
	if (result.outcome === 'idempotency_conflict') {
		return idempotencyConflict(
			instance,
			'The Idempotency-Key was already used for a different instance member status change request.'
		);
	}
	return integrityError(instance);
}
