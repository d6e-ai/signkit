import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodType } from 'zod';
import {
	InvalidApiKeyRequestError,
	type ApiKeyApplicationPort,
	type ApiKeyRequestActor,
	type RevokeApiKeyResult
} from '$lib/application/api-keys/api-key-service';
import {
	acceptsJson,
	readJsonBody,
	validationErrors,
	type JsonBodyResult
} from './bounded-json-body';
import { authorizeIdentityRequest, type AuthorizedIdentityActor } from './identity-authorization';
import { problemResponse } from './problem';

const MAX_BODY_BYTES: number = 1024;

const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');

/** Revoke carries no fields of its own: an empty object is the only valid body. */
const revokeSchema = z.object({}).strict();

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type ApiKeyRevokeApplicationResolver = (
	context: ResolverContext
) => ApiKeyApplicationPort | null | Promise<ApiKeyApplicationPort | null>;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown error';
}

export function createApiKeyRevokeHandler(
	resolveApplication: ApiKeyRevokeApplicationResolver
): RequestHandler {
	return async ({ locals, params, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		// A missing or malformed id can never identify a key, so it is routed
		// through the same `not_found` outcome as an unknown or cross-owner id
		// rather than answered with a distinct validation error.
		const apiKeyId: string = params.apiKeyId ?? '';

		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success) {
			return problemResponse({
				type: 'urn:signkit:problem:idempotency-key-required',
				title: 'Valid Idempotency-Key required',
				status: 400,
				detail: 'POST requests require one non-empty visible-ASCII Idempotency-Key header.',
				instance: url.pathname,
				errors: validationErrors(idempotencyKey.error.issues)
			});
		}
		if (!acceptsJson(request)) {
			return problemResponse({
				type: 'urn:signkit:problem:unsupported-media-type',
				title: 'Unsupported media type',
				status: 415,
				detail: 'Revoke commands require an application/json request body.',
				instance: url.pathname
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
							instance: url.pathname
						}
					: {
							type: 'urn:signkit:problem:invalid-json',
							title: 'Invalid JSON',
							status: 400,
							detail: 'The request body must be valid JSON.',
							instance: url.pathname
						}
			);
		}
		const parsed = revokeSchema.safeParse(body.value);
		if (!parsed.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'The revoke command did not match the required schema.',
				instance: url.pathname,
				errors: validationErrors(parsed.error.issues)
			});
		}

		let application: ApiKeyApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'api_key_revoke_resolution_failed', message: errorMessage(error) })
			);
			application = null;
		}
		if (application === null) {
			return problemResponse({
				type: 'urn:signkit:problem:persistence-unavailable',
				title: 'API key persistence unavailable',
				status: 503,
				detail: 'The durable API key store is not configured for this deployment.',
				instance: url.pathname
			});
		}

		const actor: ApiKeyRequestActor = { id: authorized.id };
		try {
			const result: RevokeApiKeyResult = await application.revokeApiKey(actor, apiKeyId, {
				idempotencyKey: idempotencyKey.data
			});
			return revokeResponse(result, url.pathname);
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
				JSON.stringify({ event: 'api_key_revoke_failed', message: errorMessage(error) })
			);
			return problemResponse({
				type: 'urn:signkit:problem:service-unavailable',
				title: 'API key service unavailable',
				status: 503,
				detail: 'The API key operation could not be completed.',
				instance: url.pathname
			});
		}
	};
}

function revokeResponse(result: RevokeApiKeyResult, instance: string): Response {
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
		return new Response(JSON.stringify({ apiKey: result.key }), { status: 200, headers });
	}
	if (result.outcome === 'idempotency_conflict') {
		return problemResponse({
			type: 'urn:signkit:problem:api-key-idempotency-conflict',
			title: 'Idempotency key conflict',
			status: 409,
			detail: 'The Idempotency-Key was already used for a different revoke command.',
			instance
		});
	}
	if (result.outcome === 'not_found') {
		return problemResponse({
			type: 'urn:signkit:problem:api-key-not-found',
			title: 'API key not found',
			status: 404,
			detail: 'No API key was found for the authenticated caller.',
			instance
		});
	}
	if (result.outcome === 'owner_not_active') {
		return problemResponse({
			type: 'urn:signkit:problem:api-key-owner-not-active',
			title: 'API key owner is not active',
			status: 403,
			detail: 'The authenticated caller is not an active instance member.',
			instance
		});
	}
	return problemResponse({
		type: 'urn:signkit:problem:api-key-integrity-error',
		title: 'API key integrity check failed',
		status: 503,
		detail: 'The revoke command could not prove a consistent key state.',
		instance
	});
}
