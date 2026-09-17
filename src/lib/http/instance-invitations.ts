import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import {
	InstanceInvitationCollisionExhaustedError,
	InvalidInstanceInvitationRequestError,
	type AcceptInstanceInvitationResult,
	type CreateInstanceInvitationResult,
	type InstanceInvitationActor,
	type InstanceInvitationApplicationPort,
	type ListInstanceInvitationsResult,
	type RevokeInstanceInvitationResult
} from '$lib/application/instance-invitations/instance-invitation-service';
import {
	DEFAULT_INSTANCE_INVITATION_LIST_LIMIT,
	MAX_INSTANCE_INVITATION_LIST_LIMIT,
	type InstanceMemberMetadata,
	type InstanceMemberRole
} from '$lib/ports/instance-store';
import {
	INSTANCE_INVITATION_EMAIL_MAX_LENGTH,
	INSTANCE_INVITATION_TOKEN_PATTERN
} from '$lib/security/instance-invitation';
import {
	acceptsJson,
	readJsonBody,
	validationErrors,
	type JsonBodyResult
} from './bounded-json-body';
import { authorizeIdentityRequest, type AuthorizedIdentityActor } from './identity-authorization';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_CREATE_BODY_BYTES: number = 4 * 1024;
const MAX_ACCEPT_BODY_BYTES: number = 4 * 1024;
const MAX_REVOKE_BODY_BYTES: number = 1024;

const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');

/**
 * Deliberately loose on the email/role shape: type and bound only, never a
 * full RFC 5321 format check here. The application service already performs
 * complete normalization and validation and is the single source of truth
 * for what a valid address or role looks like.
 *
 * `expiresAt` is intentionally not part of this schema: the public API never
 * accepts a caller-supplied expiry, so every created invitation gets the
 * service's fixed default lifetime.
 */
const createInstanceInvitationSchema: ZodType<{
	email: string;
	role: InstanceMemberRole;
	locale?: 'en' | 'ja';
}> = z
	.object({
		email: z.string().min(1).max(INSTANCE_INVITATION_EMAIL_MAX_LENGTH),
		role: z.enum(['owner', 'admin', 'member']),
		locale: z.enum(['en', 'ja']).optional()
	})
	.strict();

// Deliberately not shape-checked beyond a bounded length: the durable store
// must authorize the actor before a cursor can be resolved, so a malformed
// cursor is forwarded opaquely and fails closed there (an empty page, or
// forbidden/member_suspended for an actor who cannot list at all) rather
// than being rejected here on shape.
const listInstanceInvitationsSchema: ZodType<{ cursor?: string; limit: number }> = z
	.object({
		cursor: z.string().min(1).max(200).optional(),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(MAX_INSTANCE_INVITATION_LIST_LIMIT)
			.default(DEFAULT_INSTANCE_INVITATION_LIST_LIMIT)
	})
	.strict();

const acceptInstanceInvitationSchema: ZodType<{ token: string }> = z
	.object({
		token: z.string().regex(INSTANCE_INVITATION_TOKEN_PATTERN, 'Invalid instance invitation token')
	})
	.strict();

/** Revoke carries no fields of its own: an empty object is the only valid body. */
const revokeInstanceInvitationSchema = z.object({}).strict();

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type InstanceInvitationApplicationResolver = (
	context: ResolverContext
) => InstanceInvitationApplicationPort | null | Promise<InstanceInvitationApplicationPort | null>;

export interface InstanceInvitationHttpHandlers {
	create: RequestHandler;
	list: RequestHandler;
	accept: RequestHandler;
	revoke: RequestHandler;
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
		title: 'Instance invitation persistence unavailable',
		status: 503,
		detail: 'The durable instance invitation store is not configured for this deployment.',
		instance
	});
}

function serviceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-invitation-service-unavailable',
		title: 'Instance invitation service unavailable',
		status: 503,
		detail: 'The instance invitation operation could not be completed.',
		instance
	});
}

function forbidden(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-invitation-forbidden',
		title: 'Instance invitation actor not permitted',
		status: 403,
		detail: 'The authenticated caller is not an active instance owner or admin.',
		instance
	});
}

function roleNotPermitted(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-invitation-role-not-permitted',
		title: 'Instance invitation role not permitted',
		status: 403,
		detail: 'The authenticated caller may not grant the requested role.',
		instance
	});
}

function limitReached(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-invitation-limit',
		title: 'Instance invitation limit reached',
		status: 409,
		detail: 'The instance has reached its pending invitation limit.',
		instance
	});
}

function idempotencyConflict(instance: string, detail: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-invitation-idempotency-conflict',
		title: 'Idempotency key conflict',
		status: 409,
		detail,
		instance
	});
}

function memberSuspended(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-invitation-member-suspended',
		title: 'Instance invitation actor suspended',
		status: 403,
		detail: 'The authenticated caller is not an active instance member.',
		instance
	});
}

function invitationNotFound(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-invitation-not-found',
		title: 'Instance invitation not found',
		status: 404,
		detail: 'No instance invitation was found for the requested identifier.',
		instance
	});
}

/**
 * Distinct from the opaque `invitationCannotBeAccepted` 404 below: a caller
 * who is already an active instance member already knows their own
 * membership, so disclosing that fact (and only that fact — the invitation
 * itself is left pending and unconsumed, and neither it nor the token is
 * ever included here) leaks nothing a probing caller couldn't already know
 * about themselves.
 */
function instanceMemberAlreadyExists(instance: string, member: InstanceMemberMetadata): Response {
	return new Response(
		JSON.stringify({
			type: 'urn:signkit:problem:instance-member-already-exists',
			title: 'Instance member already exists',
			status: 409,
			detail: 'The authenticated caller is already an active instance member.',
			instance,
			member
		}),
		{
			status: 409,
			headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' }
		}
	);
}

/**
 * Opaque by design: an invalid, expired, or wrong-email token and an
 * already-suspended accepting member share this exact type and detail, so
 * neither can be distinguished from the other by a caller probing accept.
 */
function invitationCannotBeAccepted(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-invitation-invalid',
		title: 'Instance invitation cannot be accepted',
		status: 404,
		detail: 'The instance invitation could not be accepted.',
		instance
	});
}

function integrityError(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-invitation-integrity-error',
		title: 'Instance invitation integrity check failed',
		status: 503,
		detail: 'The instance invitation command could not prove a consistent state.',
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

async function resolveApplicationOrProblem(
	resolveApplication: InstanceInvitationApplicationResolver,
	context: ResolverContext,
	instance: string,
	event: string
): Promise<InstanceInvitationApplicationPort | Response> {
	let application: InstanceInvitationApplicationPort | null;
	try {
		application = await resolveApplication(context);
	} catch (error: unknown) {
		console.error(JSON.stringify({ event, message: operationErrorName(error) }));
		application = null;
	}
	return application === null ? persistenceUnavailable(instance) : application;
}

function actorOf(authorized: AuthorizedIdentityActor): InstanceInvitationActor {
	return { id: authorized.id };
}

export function createInstanceInvitationHttpHandlers(
	resolveApplication: InstanceInvitationApplicationResolver
): InstanceInvitationHttpHandlers {
	const create: RequestHandler = async ({ locals, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success) {
			return idempotencyKeyRequired(url.pathname, idempotencyKey.error.issues);
		}
		if (!acceptsJson(request)) {
			return unsupportedMediaType(
				url.pathname,
				'Instance invitation creation requires an application/json request body.'
			);
		}

		const body: JsonBodyResult = await readJsonBody(request, MAX_CREATE_BODY_BYTES);
		if (!body.ok) {
			return body.reason === 'too_large'
				? bodyTooLarge(url.pathname, MAX_CREATE_BODY_BYTES)
				: invalidJson(url.pathname);
		}

		const parsed = createInstanceInvitationSchema.safeParse(body.value);
		if (!parsed.success) {
			return validationFailed(
				url.pathname,
				'The instance invitation creation request did not match the required schema.',
				validationErrors(parsed.error.issues)
			);
		}

		const application: InstanceInvitationApplicationPort | Response =
			await resolveApplicationOrProblem(
				resolveApplication,
				{ platform },
				url.pathname,
				'instance_invitation_create_resolution_failed'
			);
		if (application instanceof Response) return application;

		try {
			const result: CreateInstanceInvitationResult = await application.create(actorOf(authorized), {
				idempotencyKey: idempotencyKey.data,
				email: parsed.data.email,
				role: parsed.data.role,
				locale: parsed.data.locale
			});
			return createResponse(result, url.pathname);
		} catch (error: unknown) {
			if (error instanceof InvalidInstanceInvitationRequestError) {
				return validationFailed(url.pathname, error.message, [
					{ path: '$', message: error.message }
				]);
			}
			const event: string =
				error instanceof InstanceInvitationCollisionExhaustedError
					? 'instance_invitation_create_collision_exhausted'
					: 'instance_invitation_create_failed';
			console.error(JSON.stringify({ event, message: operationErrorName(error) }));
			return serviceUnavailable(url.pathname);
		}
	};

	const list: RequestHandler = async ({ locals, platform, url }): Promise<Response> => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		const query = listInstanceInvitationsSchema.safeParse(Object.fromEntries(url.searchParams));
		if (!query.success) {
			return validationFailed(
				url.pathname,
				'The instance invitation list query did not match the required schema.',
				validationErrors(query.error.issues)
			);
		}

		const application: InstanceInvitationApplicationPort | Response =
			await resolveApplicationOrProblem(
				resolveApplication,
				{ platform },
				url.pathname,
				'instance_invitation_list_resolution_failed'
			);
		if (application instanceof Response) return application;

		try {
			const result: ListInstanceInvitationsResult = await application.list(actorOf(authorized), {
				cursor: query.data.cursor ?? null,
				limit: query.data.limit
			});
			if (result.outcome === 'forbidden') return forbidden(url.pathname);
			if (result.outcome === 'member_suspended') return memberSuspended(url.pathname);
			return new Response(
				JSON.stringify({ invitations: result.page.items, nextCursor: result.page.nextCursor }),
				{
					status: 200,
					headers: { 'cache-control': 'no-store', 'content-type': 'application/json' }
				}
			);
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'instance_invitation_list_failed',
					message: operationErrorName(error)
				})
			);
			return serviceUnavailable(url.pathname);
		}
	};

	const accept: RequestHandler = async ({ locals, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success) {
			return idempotencyKeyRequired(url.pathname, idempotencyKey.error.issues);
		}
		if (!acceptsJson(request)) {
			return unsupportedMediaType(
				url.pathname,
				'Instance invitation acceptance requires an application/json request body.'
			);
		}

		const body: JsonBodyResult = await readJsonBody(request, MAX_ACCEPT_BODY_BYTES);
		if (!body.ok) {
			return body.reason === 'too_large'
				? bodyTooLarge(url.pathname, MAX_ACCEPT_BODY_BYTES)
				: invalidJson(url.pathname);
		}

		const parsed = acceptInstanceInvitationSchema.safeParse(body.value);
		if (!parsed.success) {
			return validationFailed(
				url.pathname,
				'The instance invitation acceptance request did not match the required schema.',
				validationErrors(parsed.error.issues)
			);
		}

		// The asserted email is the caller's own authenticated d6e-auth
		// identity email claim, never a value the request body can supply.
		// Missing or false `email_verified` fails closed: holding a session
		// is not a provider-verified inbox guarantee.
		if (authorized.emailVerified !== true) {
			return problemResponse({
				type: 'urn:signkit:problem:email-verification-required',
				title: 'Email verification required',
				status: 403,
				detail: 'Accepting an invitation requires a provider-verified email claim.',
				instance: url.pathname
			});
		}

		const application: InstanceInvitationApplicationPort | Response =
			await resolveApplicationOrProblem(
				resolveApplication,
				{ platform },
				url.pathname,
				'instance_invitation_accept_resolution_failed'
			);
		if (application instanceof Response) return application;

		try {
			const result: AcceptInstanceInvitationResult = await application.accept(actorOf(authorized), {
				idempotencyKey: idempotencyKey.data,
				token: parsed.data.token,
				email: authorized.email
			});
			return acceptResponse(result, url.pathname);
		} catch (error: unknown) {
			if (error instanceof InvalidInstanceInvitationRequestError) {
				return validationFailed(url.pathname, error.message, [
					{ path: '$', message: error.message }
				]);
			}
			console.error(
				JSON.stringify({
					event: 'instance_invitation_accept_failed',
					message: operationErrorName(error)
				})
			);
			return serviceUnavailable(url.pathname);
		}
	};

	const revoke: RequestHandler = async ({
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

		const invitationId: string = params.invitationId ?? '';

		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success) {
			return idempotencyKeyRequired(url.pathname, idempotencyKey.error.issues);
		}
		if (!acceptsJson(request)) {
			return unsupportedMediaType(
				url.pathname,
				'Instance invitation revocation requires an application/json request body.'
			);
		}

		const body: JsonBodyResult = await readJsonBody(request, MAX_REVOKE_BODY_BYTES);
		if (!body.ok) {
			return body.reason === 'too_large'
				? bodyTooLarge(url.pathname, MAX_REVOKE_BODY_BYTES)
				: invalidJson(url.pathname);
		}

		const parsed = revokeInstanceInvitationSchema.safeParse(body.value);
		if (!parsed.success) {
			return validationFailed(
				url.pathname,
				'The instance invitation revoke command did not match the required schema.',
				validationErrors(parsed.error.issues)
			);
		}

		const application: InstanceInvitationApplicationPort | Response =
			await resolveApplicationOrProblem(
				resolveApplication,
				{ platform },
				url.pathname,
				'instance_invitation_revoke_resolution_failed'
			);
		if (application instanceof Response) return application;

		try {
			const result: RevokeInstanceInvitationResult = await application.revoke(
				actorOf(authorized),
				invitationId,
				{ idempotencyKey: idempotencyKey.data }
			);
			return revokeResponse(result, url.pathname);
		} catch (error: unknown) {
			if (error instanceof InvalidInstanceInvitationRequestError) {
				return validationFailed(url.pathname, error.message, [
					{ path: '$', message: error.message }
				]);
			}
			console.error(
				JSON.stringify({
					event: 'instance_invitation_revoke_failed',
					message: operationErrorName(error)
				})
			);
			return serviceUnavailable(url.pathname);
		}
	};

	return { create, list, accept, revoke };
}

function createResponse(result: CreateInstanceInvitationResult, instance: string): Response {
	if (result.outcome === 'created') {
		return new Response(
			JSON.stringify({ invitation: result.invitation, delivery: { status: 'scheduled' } }),
			{
				status: 201,
				headers: { 'cache-control': 'no-store', 'content-type': 'application/json' }
			}
		);
	}
	if (result.outcome === 'replayed') {
		return new Response(
			JSON.stringify({ invitation: result.invitation, delivery: { status: 'scheduled' } }),
			{
				status: 200,
				headers: {
					'cache-control': 'no-store',
					'content-type': 'application/json',
					'idempotency-replayed': 'true'
				}
			}
		);
	}
	if (result.outcome === 'forbidden') return forbidden(instance);
	if (result.outcome === 'role_not_permitted') return roleNotPermitted(instance);
	if (result.outcome === 'limit') return limitReached(instance);
	if (result.outcome === 'idempotency_conflict') {
		return idempotencyConflict(
			instance,
			'The Idempotency-Key was already used for a different instance invitation creation request.'
		);
	}
	if (result.outcome === 'member_suspended') return memberSuspended(instance);
	return integrityError(instance);
}

function acceptResponse(result: AcceptInstanceInvitationResult, instance: string): Response {
	if (result.outcome === 'accepted' || result.outcome === 'replayed') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(JSON.stringify({ invitation: result.invitation, member: result.member }), {
			status: 200,
			headers
		});
	}
	if (result.outcome === 'already_member') {
		return instanceMemberAlreadyExists(instance, result.member);
	}
	if (result.outcome === 'invitation_invalid' || result.outcome === 'member_suspended') {
		return invitationCannotBeAccepted(instance);
	}
	if (result.outcome === 'idempotency_conflict') {
		return idempotencyConflict(
			instance,
			'The Idempotency-Key was already used for a different instance invitation acceptance request.'
		);
	}
	return integrityError(instance);
}

function revokeResponse(result: RevokeInstanceInvitationResult, instance: string): Response {
	if (result.outcome === 'revoked' || result.outcome === 'replayed') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(JSON.stringify({ invitation: result.invitation }), {
			status: 200,
			headers
		});
	}
	if (result.outcome === 'forbidden') return forbidden(instance);
	if (result.outcome === 'member_suspended') return memberSuspended(instance);
	if (result.outcome === 'invitation_invalid') return invitationNotFound(instance);
	if (result.outcome === 'idempotency_conflict') {
		return idempotencyConflict(
			instance,
			'The Idempotency-Key was already used for a different instance invitation revoke command.'
		);
	}
	return integrityError(instance);
}
