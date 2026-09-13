import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import {
	InvalidApiKeyRequestError,
	type ApiKeyApplicationPort,
	type ApiKeyRequestActor,
	type GrantApiKeyOrganizationResult,
	type ListApiKeyOrganizationGrantsResult,
	type RevokeApiKeyOrganizationGrantResult
} from '$lib/application/api-keys/api-key-service';
import {
	DEFAULT_API_KEY_GRANT_LIST_LIMIT,
	MAX_API_KEY_GRANT_LIST_LIMIT,
	type ApiKeyGrantingOrganizationRole
} from '$lib/ports/api-key-store';
import {
	acceptsJson,
	readJsonBody,
	validationErrors,
	type JsonBodyResult
} from './bounded-json-body';
import { authorizeIdentityRequest, type AuthorizedIdentityActor } from './identity-authorization';
import {
	authorizeOrganizationRequest,
	resolveOrganizationAdminScope,
	type AuthorizedRequestActor
} from './organization-authorization';
import { problemResponse } from './problem';

const MAX_BODY_BYTES: number = 1024;

const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');

/**
 * Both mutations carry no fields of their own: an empty object is the only valid
 * body.
 *
 * Grant creation in particular must never accept an organization field. The
 * organization is whichever one the verified session already selected, so there
 * is nothing for a caller to supply and nothing for a caller to substitute.
 */
const emptyBodySchema = z.object({}).strict();

// Deliberately not a UUID format check, matching the key list: the durable store
// must authorize the owner before a cursor can be resolved, so a malformed
// cursor is forwarded opaquely and fails closed there.
const listGrantsSchema: ZodType<{ cursor?: string; limit: number }> = z
	.object({
		cursor: z.string().min(1).max(200).optional(),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(MAX_API_KEY_GRANT_LIST_LIMIT)
			.default(DEFAULT_API_KEY_GRANT_LIST_LIMIT)
	})
	.strict();

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type ApiKeyGrantApplicationResolver = (
	context: ResolverContext
) => ApiKeyApplicationPort | null | Promise<ApiKeyApplicationPort | null>;

export interface ApiKeyOrganizationGrantHandlers {
	create: RequestHandler;
	list: RequestHandler;
	revoke: RequestHandler;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown error';
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

function grantNotFound(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:api-key-organization-grant-not-found',
		title: 'API key organization grant not found',
		status: 404,
		detail: 'No matching API key organization grant was found for the authorized caller.',
		instance
	});
}

function ownerNotActive(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:api-key-owner-not-active',
		title: 'API key owner is not active',
		status: 403,
		detail: 'The authenticated caller is not an active instance member.',
		instance
	});
}

function grantIntegrityError(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:api-key-grant-integrity-error',
		title: 'API key grant integrity check failed',
		status: 503,
		detail: 'The grant command could not prove a consistent grant state.',
		instance
	});
}

function grantIdempotencyConflict(instance: string, detail: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:api-key-grant-idempotency-conflict',
		title: 'Idempotency key conflict',
		status: 409,
		detail,
		instance
	});
}

function serviceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:service-unavailable',
		title: 'API key service unavailable',
		status: 503,
		detail: 'The API key grant operation could not be completed.',
		instance
	});
}

async function resolveApplicationOrProblem(
	resolveApplication: ApiKeyGrantApplicationResolver,
	context: ResolverContext,
	instance: string,
	event: string
): Promise<ApiKeyApplicationPort | Response> {
	let application: ApiKeyApplicationPort | null;
	try {
		application = await resolveApplication(context);
	} catch (error: unknown) {
		console.error(JSON.stringify({ event, message: errorMessage(error) }));
		application = null;
	}
	if (application !== null) return application;
	return problemResponse({
		type: 'urn:signkit:problem:persistence-unavailable',
		title: 'API key persistence unavailable',
		status: 503,
		detail: 'The durable API key store is not configured for this deployment.',
		instance
	});
}

/**
 * Reads and validates the shared mutation preamble: `Idempotency-Key`,
 * `application/json`, and an exact empty object body bounded to 1 KiB.
 */
async function readMutationPreamble(
	request: Request,
	instance: string
): Promise<{ idempotencyKey: string } | Response> {
	const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
	if (!idempotencyKey.success) {
		return idempotencyKeyRequired(instance, idempotencyKey.error.issues);
	}
	if (!acceptsJson(request)) {
		return problemResponse({
			type: 'urn:signkit:problem:unsupported-media-type',
			title: 'Unsupported media type',
			status: 415,
			detail: 'Grant commands require an application/json request body.',
			instance
		});
	}
	const body: JsonBodyResult = await readJsonBody(request, MAX_BODY_BYTES);
	if (!body.ok) {
		return problemResponse(
			body.reason === 'too_large'
				? {
						type: 'urn:signkit:problem:request-body-too-large',
						title: 'Request body too large',
						status: 413,
						detail: `The request body must not exceed ${MAX_BODY_BYTES} bytes.`,
						instance
					}
				: {
						type: 'urn:signkit:problem:invalid-json',
						title: 'Invalid JSON',
						status: 400,
						detail: 'The request body must be valid JSON.',
						instance
					}
		);
	}
	const parsed = emptyBodySchema.safeParse(body.value);
	if (!parsed.success) {
		return problemResponse({
			type: 'urn:signkit:problem:validation-failed',
			title: 'Request validation failed',
			status: 400,
			detail: 'The grant command did not match the required schema.',
			instance,
			errors: validationErrors(parsed.error.issues)
		});
	}
	return { idempotencyKey: idempotencyKey.data };
}

export function createApiKeyOrganizationGrantHandlers(
	resolveApplication: ApiKeyGrantApplicationResolver
): ApiKeyOrganizationGrantHandlers {
	/**
	 * Granting an API key access to a d6e organization requires both authorities
	 * at once, and that conjunction is the entire point of this endpoint:
	 *
	 * - d6e organization authority, proven by `authorizeOrganizationRequest` plus a
	 *   current `owner`/`admin` role in the session-selected organization. This is
	 *   live d6e authority, never local instance role -- a SignKit instance owner is
	 *   not thereby an organization owner.
	 * - instance authority over the key, proven downstream: the store requires the
	 *   caller to be the key's own currently active `instance_member` owner. An
	 *   instance administrator cannot grant on someone else's key in this slice.
	 *
	 * The organization is taken from the session, so a caller can only ever grant
	 * an organization they are currently authorized for. Nothing in the request
	 * body can widen that.
	 */
	const create: RequestHandler = async ({ locals, params, platform, request, url }) => {
		const authorized: AuthorizedRequestActor | Response = authorizeOrganizationRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		if (authorized.organizationRole !== 'owner' && authorized.organizationRole !== 'admin') {
			return problemResponse({
				type: 'urn:signkit:problem:api-key-organization-grant-forbidden',
				title: 'Organization administration required',
				status: 403,
				detail:
					'Granting an API key access to an organization requires an owner or admin role in that organization.',
				instance: url.pathname
			});
		}
		const grantingOrganizationRole: ApiKeyGrantingOrganizationRole = authorized.organizationRole;

		const preamble = await readMutationPreamble(request, url.pathname);
		if (preamble instanceof Response) return preamble;

		const application: ApiKeyApplicationPort | Response = await resolveApplicationOrProblem(
			resolveApplication,
			{ platform },
			url.pathname,
			'api_key_grant_create_resolution_failed'
		);
		if (application instanceof Response) return application;

		// A missing or malformed id can never identify a key, so it is routed
		// through the same opaque not-found outcome as an unknown or cross-owner id.
		const apiKeyId: string = params.apiKeyId ?? '';
		const actor: ApiKeyRequestActor = { id: authorized.id };
		try {
			const result: GrantApiKeyOrganizationResult = await application.grantApiKeyOrganization(
				actor,
				apiKeyId,
				{
					idempotencyKey: preamble.idempotencyKey,
					organizationId: authorized.organizationId,
					organizationName: authorized.organizationName,
					grantingOrganizationRole
				}
			);
			return grantResponse(result, url.pathname);
		} catch (error: unknown) {
			if (error instanceof InvalidApiKeyRequestError) {
				return problemResponse({
					type: 'urn:signkit:problem:validation-failed',
					title: 'Request validation failed',
					status: 400,
					detail: error.message,
					instance: url.pathname,
					errors: [{ path: '$', message: error.message }]
				});
			}
			console.error(
				JSON.stringify({ event: 'api_key_grant_create_failed', message: errorMessage(error) })
			);
			return serviceUnavailable(url.pathname);
		}
	};

	/** Owner-scoped: only the key's own active instance-member owner may enumerate its grants. */
	const list: RequestHandler = async ({ locals, params, platform, url }) => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		const query = listGrantsSchema.safeParse(Object.fromEntries(url.searchParams));
		if (!query.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'The grant list query did not match the required schema.',
				instance: url.pathname,
				errors: validationErrors(query.error.issues)
			});
		}

		const application: ApiKeyApplicationPort | Response = await resolveApplicationOrProblem(
			resolveApplication,
			{ platform },
			url.pathname,
			'api_key_grant_list_resolution_failed'
		);
		if (application instanceof Response) return application;

		const apiKeyId: string = params.apiKeyId ?? '';
		try {
			const result: ListApiKeyOrganizationGrantsResult =
				await application.listApiKeyOrganizationGrants({ id: authorized.id }, apiKeyId, {
					cursor: query.data.cursor ?? null,
					limit: query.data.limit
				});
			if (result.outcome === 'owner_not_active') return ownerNotActive(url.pathname);
			if (result.outcome === 'not_found') return grantNotFound(url.pathname);
			return new Response(JSON.stringify({ page: result.page }), {
				status: 200,
				headers: { 'cache-control': 'no-store', 'content-type': 'application/json' }
			});
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'api_key_grant_list_failed', message: errorMessage(error) })
			);
			return serviceUnavailable(url.pathname);
		}
	};

	/**
	 * Revocation is de-escalation, so it deliberately accepts *less* authority than
	 * granting and admits two independent paths:
	 *
	 * - the key's own currently active instance-member owner, who needs no d6e
	 *   organization membership at all -- losing organization membership must never
	 *   strand an operator with a key they cannot de-scope;
	 * - a current d6e `owner`/`admin` of the session-selected organization, who may
	 *   revoke any grant *for that organization* even without owning the key. This
	 *   is the immediate organization-side control over an agent that a d6e
	 *   organization can exercise without waiting on the key's owner.
	 *
	 * Both are claimed here and re-proven durably by the store, which resolves
	 * `key_owner` first so the recorded authority is deterministic. The
	 * organization scope is resolved from the verified session, never from a
	 * request field, so an identity-only caller can never revoke grants for an
	 * organization they have no authority over -- they simply carry no organization
	 * scope and fall back to the owner path.
	 */
	const revoke: RequestHandler = async ({ locals, params, platform, request, url }) => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;
		const organizationScope: string | null = resolveOrganizationAdminScope(locals);

		const preamble = await readMutationPreamble(request, url.pathname);
		if (preamble instanceof Response) return preamble;

		const application: ApiKeyApplicationPort | Response = await resolveApplicationOrProblem(
			resolveApplication,
			{ platform },
			url.pathname,
			'api_key_grant_revoke_resolution_failed'
		);
		if (application instanceof Response) return application;

		const apiKeyId: string = params.apiKeyId ?? '';
		const grantId: string = params.grantId ?? '';
		try {
			const result: RevokeApiKeyOrganizationGrantResult =
				await application.revokeApiKeyOrganizationGrant({ id: authorized.id }, apiKeyId, grantId, {
					idempotencyKey: preamble.idempotencyKey,
					ownerScope: true,
					organizationScope
				});
			return revokeGrantResponse(result, url.pathname);
		} catch (error: unknown) {
			if (error instanceof InvalidApiKeyRequestError) {
				return problemResponse({
					type: 'urn:signkit:problem:validation-failed',
					title: 'Request validation failed',
					status: 400,
					detail: error.message,
					instance: url.pathname,
					errors: [{ path: '$', message: error.message }]
				});
			}
			console.error(
				JSON.stringify({ event: 'api_key_grant_revoke_failed', message: errorMessage(error) })
			);
			return serviceUnavailable(url.pathname);
		}
	};

	return { create, list, revoke };
}

function grantResponse(result: GrantApiKeyOrganizationResult, instance: string): Response {
	if (result.outcome === 'granted') {
		return new Response(JSON.stringify({ grant: result.grant }), {
			status: 201,
			headers: {
				'cache-control': 'no-store',
				'content-type': 'application/json',
				location: `/api/v1/api-keys/${result.grant.apiKeyId}/organization-grants/${result.grant.id}`
			}
		});
	}
	if (result.outcome === 'replayed' || result.outcome === 'already_granted') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		// Only a genuine exact-key replay is labelled as one. A fresh key naming an
		// organization the key already reaches is a no-op, not a replay, and saying
		// otherwise would misreport which request the response belongs to.
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(JSON.stringify({ grant: result.grant }), { status: 200, headers });
	}
	if (result.outcome === 'idempotency_conflict') {
		return grantIdempotencyConflict(
			instance,
			'The Idempotency-Key was already used for a different grant request.'
		);
	}
	if (result.outcome === 'not_found') return grantNotFound(instance);
	if (result.outcome === 'key_not_active') {
		return problemResponse({
			type: 'urn:signkit:problem:api-key-not-active',
			title: 'API key is not active',
			status: 409,
			detail: 'A revoked or expired API key cannot be granted organization access.',
			instance
		});
	}
	if (result.outcome === 'owner_not_active') return ownerNotActive(instance);
	return grantIntegrityError(instance);
}

function revokeGrantResponse(
	result: RevokeApiKeyOrganizationGrantResult,
	instance: string
): Response {
	if (
		result.outcome === 'revoked' ||
		result.outcome === 'replayed' ||
		result.outcome === 'already_revoked'
	) {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(JSON.stringify({ grant: result.grant }), { status: 200, headers });
	}
	if (result.outcome === 'idempotency_conflict') {
		return grantIdempotencyConflict(
			instance,
			'The Idempotency-Key was already used for a different grant revoke request.'
		);
	}
	if (result.outcome === 'not_found') return grantNotFound(instance);
	if (result.outcome === 'owner_not_active') return ownerNotActive(instance);
	return grantIntegrityError(instance);
}
