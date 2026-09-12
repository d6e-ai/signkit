import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import {
	InvalidApiKeyRequestError,
	type ApiKeyApplicationPort,
	type ApiKeyRequestActor,
	type CreateApiKeyResult,
	type ListApiKeyResult
} from '$lib/application/api-keys/api-key-service';
import { DEFAULT_API_KEY_LIST_LIMIT, MAX_API_KEY_LIST_LIMIT } from '$lib/ports/api-key-store';
import {
	acceptsJson,
	readJsonBody,
	validationErrors,
	type JsonBodyResult
} from './bounded-json-body';
import { authorizeIdentityRequest, type AuthorizedIdentityActor } from './identity-authorization';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_CREATE_BODY_BYTES: number = 4 * 1024;

const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');

const createApiKeySchema: ZodType<{
	name: string;
	scopes: readonly string[];
	expiresAt?: string | null;
}> = z
	.object({
		name: z.string().max(1000),
		scopes: z.array(z.string().max(100)).max(20),
		expiresAt: z.union([z.string().max(200), z.null()]).optional()
	})
	.strict();

// Deliberately not a UUID format check: the durable store must authorize the
// owner before a cursor can be resolved, so a malformed cursor is forwarded
// opaquely and fails closed there (owner_not_active for an inactive owner, an
// empty page for an active one) rather than being rejected here on shape.
const listApiKeysSchema: ZodType<{ cursor?: string; limit: number }> = z
	.object({
		cursor: z.string().min(1).max(200).optional(),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(MAX_API_KEY_LIST_LIMIT)
			.default(DEFAULT_API_KEY_LIST_LIMIT)
	})
	.strict();

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type ApiKeyApplicationResolver = (
	context: ResolverContext
) => ApiKeyApplicationPort | null | Promise<ApiKeyApplicationPort | null>;

export interface ApiKeyHttpHandlers {
	create: RequestHandler;
	list: RequestHandler;
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

function unsupportedMediaType(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:unsupported-media-type',
		title: 'Unsupported media type',
		status: 415,
		detail: 'API key creation requires an application/json request body.',
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
		title: 'API key persistence unavailable',
		status: 503,
		detail: 'The durable API key store is not configured for this deployment.',
		instance
	});
}

function serviceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:service-unavailable',
		title: 'API key service unavailable',
		status: 503,
		detail: 'The API key operation could not be completed.',
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

function integrityError(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:api-key-integrity-error',
		title: 'API key integrity check failed',
		status: 503,
		detail: 'The API key command could not prove a consistent key state.',
		instance
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown error';
}

async function resolveApplicationOrProblem(
	resolveApplication: ApiKeyApplicationResolver,
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
	return application === null ? persistenceUnavailable(instance) : application;
}

function actorOf(authorized: AuthorizedIdentityActor): ApiKeyRequestActor {
	return { id: authorized.id };
}

export function createApiKeyHttpHandlers(
	resolveApplication: ApiKeyApplicationResolver
): ApiKeyHttpHandlers {
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
		if (!acceptsJson(request)) return unsupportedMediaType(url.pathname);

		const body: JsonBodyResult = await readJsonBody(request, MAX_CREATE_BODY_BYTES);
		if (!body.ok) {
			return body.reason === 'too_large'
				? bodyTooLarge(url.pathname, MAX_CREATE_BODY_BYTES)
				: invalidJson(url.pathname);
		}

		const parsed = createApiKeySchema.safeParse(body.value);
		if (!parsed.success) {
			return validationFailed(
				url.pathname,
				'The API key creation request did not match the required schema.',
				validationErrors(parsed.error.issues)
			);
		}

		const application: ApiKeyApplicationPort | Response = await resolveApplicationOrProblem(
			resolveApplication,
			{ platform },
			url.pathname,
			'api_key_create_resolution_failed'
		);
		if (application instanceof Response) return application;

		try {
			const result: CreateApiKeyResult = await application.createApiKey(actorOf(authorized), {
				idempotencyKey: idempotencyKey.data,
				name: parsed.data.name,
				scopes: parsed.data.scopes,
				expiresAt: parsed.data.expiresAt
			});
			return createResponse(result, url.pathname);
		} catch (error: unknown) {
			if (error instanceof InvalidApiKeyRequestError) {
				return validationFailed(url.pathname, error.message, [
					{ path: '$', message: error.message }
				]);
			}
			console.error(
				JSON.stringify({ event: 'api_key_create_failed', message: errorMessage(error) })
			);
			return serviceUnavailable(url.pathname);
		}
	};

	const list: RequestHandler = async ({ locals, platform, url }): Promise<Response> => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		const query = listApiKeysSchema.safeParse(Object.fromEntries(url.searchParams));
		if (!query.success) {
			return validationFailed(
				url.pathname,
				'The API key list query did not match the required schema.',
				validationErrors(query.error.issues)
			);
		}

		const application: ApiKeyApplicationPort | Response = await resolveApplicationOrProblem(
			resolveApplication,
			{ platform },
			url.pathname,
			'api_key_list_resolution_failed'
		);
		if (application instanceof Response) return application;

		try {
			const result: ListApiKeyResult = await application.listApiKeys(actorOf(authorized), {
				cursor: query.data.cursor ?? null,
				limit: query.data.limit
			});
			if (result.outcome === 'owner_not_active') return ownerNotActive(url.pathname);
			return new Response(JSON.stringify({ page: result.page }), {
				status: 200,
				headers: { 'cache-control': 'no-store', 'content-type': 'application/json' }
			});
		} catch (error: unknown) {
			console.error(JSON.stringify({ event: 'api_key_list_failed', message: errorMessage(error) }));
			return serviceUnavailable(url.pathname);
		}
	};

	return { create, list };
}

function createResponse(result: CreateApiKeyResult, instance: string): Response {
	if (result.outcome === 'created') {
		return new Response(JSON.stringify({ apiKey: result.key, token: result.token }), {
			status: 201,
			headers: { 'cache-control': 'no-store', 'content-type': 'application/json' }
		});
	}
	if (result.outcome === 'already_issued') {
		return new Response(JSON.stringify({ apiKey: result.key }), {
			status: 200,
			headers: {
				'cache-control': 'no-store',
				'content-type': 'application/json',
				'idempotency-replayed': 'true'
			}
		});
	}
	if (result.outcome === 'idempotency_conflict') {
		return problemResponse({
			type: 'urn:signkit:problem:api-key-idempotency-conflict',
			title: 'Idempotency key conflict',
			status: 409,
			detail: 'The Idempotency-Key was already used for a different API key creation request.',
			instance
		});
	}
	if (result.outcome === 'owner_not_active') return ownerNotActive(instance);
	return integrityError(instance);
}
