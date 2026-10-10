import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import type {
	CompletionArtifactRetryResult,
	CompletionArtifactRetryService
} from '$lib/application/completion-artifacts/completion-artifact-retry';
import { authorizeScopedInstanceRequest, type AuthorizedApiActor } from './api-key-authorization';
import {
	acceptsJson,
	readJsonBody,
	validationErrors,
	type JsonBodyResult
} from './bounded-json-body';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_BODY_BYTES: number = 1_024;
const MAX_ATTEMPTS: number = 2_147_483_647;
const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');
// The status read returns the failure generation as UTC ISO-8601 with
// millisecond (D1) or microsecond (PostgreSQL) precision; it is echoed back
// verbatim, so only that exact shape is accepted.
const failedAtSchema: ZodType<string> = z
	.string()
	.regex(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/,
		'expectedFailedAt must be the failedAt value from the completion artifact status'
	);
export const retrySchema = z
	.object({
		expectedAttempts: z.number().int().min(0).max(MAX_ATTEMPTS),
		expectedFailedAt: failedAtSchema
	})
	.strict();

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

/** The handler needs only `retry`; a structural port keeps stubs honest. */
export type CompletionArtifactRetryPort = Pick<CompletionArtifactRetryService, 'retry'>;

export type CompletionArtifactRetryServiceResolver = (
	context: ResolverContext
) => CompletionArtifactRetryPort | null | Promise<CompletionArtifactRetryPort | null>;

export function createCompletionArtifactRetryHandler(
	resolveService: CompletionArtifactRetryServiceResolver
): RequestHandler {
	return async ({ locals, params, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedInstanceRequest(
			locals,
			url.pathname,
			'envelopes:send'
		);
		if (authorized instanceof Response) return authorized;

		const envelopeId = envelopeIdSchema.safeParse(params.envelopeId);
		if (!envelopeId.success) {
			return validationProblem(
				url.pathname,
				'The envelope ID must be a UUID.',
				envelopeId.error.issues
			);
		}
		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success) {
			return idempotencyRequired(url.pathname, idempotencyKey.error.issues);
		}
		if (!acceptsJson(request)) return unsupportedMediaType(url.pathname);

		const body: JsonBodyResult = await readJsonBody(request, MAX_BODY_BYTES);
		if (!body.ok) {
			return body.reason === 'too_large' ? bodyTooLarge(url.pathname) : invalidJson(url.pathname);
		}
		const parsed = retrySchema.safeParse(body.value);
		if (!parsed.success) {
			return validationProblem(
				url.pathname,
				'The completion artifact retry command did not match the required schema.',
				parsed.error.issues
			);
		}

		let service: CompletionArtifactRetryPort | null;
		try {
			service = await resolveService({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'completion_artifact_retry_resolution_failed',
					message: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			service = null;
		}
		if (service === null) return unavailable(url.pathname);

		try {
			const result: CompletionArtifactRetryResult = await service.retry({
				envelopeId: envelopeId.data,
				idempotencyKey: idempotencyKey.data,
				expectedAttempts: parsed.data.expectedAttempts,
				expectedFailedAt: parsed.data.expectedFailedAt
			});
			return retryResponse(result, envelopeId.data, url.pathname);
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'completion_artifact_retry_failed',
					message: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return serviceUnavailable(url.pathname);
		}
	};
}

function retryResponse(
	result: CompletionArtifactRetryResult,
	envelopeId: string,
	instance: string
): Response {
	if (result.outcome === 'requeued' || result.outcome === 'replayed') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(
			JSON.stringify({
				requeued: {
					envelopeId,
					target: result.target,
					outcome: result.outcome
				}
			}),
			{ status: 200, headers }
		);
	}

	const problems: Record<
		Exclude<CompletionArtifactRetryResult['outcome'], 'requeued' | 'replayed'>,
		{ type: string; title: string; status: number; detail: string }
	> = {
		conflict: {
			type: 'urn:signkit:problem:completion-artifact-retry-idempotency-conflict',
			title: 'Idempotency key conflict',
			status: 409,
			detail: 'The Idempotency-Key was already used for a different retry command.'
		},
		not_eligible: {
			type: 'urn:signkit:problem:completion-artifact-retry-not-eligible',
			title: 'Completion artifact cannot be retried',
			status: 409,
			detail:
				'Only the exhausted transient completion failure observed in the latest status read can be requeued. Refresh the status and try again.'
		},
		not_found: {
			type: 'urn:signkit:problem:envelope-not-found',
			title: 'Envelope not found',
			status: 404,
			detail: 'No envelope was found.'
		}
	};
	return problemResponse({ ...problems[result.outcome], instance });
}

function validationProblem(
	instance: string,
	detail: string,
	issues: readonly ZodIssue[]
): Response {
	return problemResponse({
		type: 'urn:signkit:problem:validation-error',
		title: 'Validation failed',
		status: 400,
		detail,
		instance,
		errors: validationErrors(issues) as ProblemValidationError[]
	});
}

function idempotencyRequired(instance: string, issues: readonly ZodIssue[]): Response {
	return problemResponse({
		type: 'urn:signkit:problem:idempotency-key-required',
		title: 'Valid Idempotency-Key required',
		status: 400,
		detail: 'POST requests require one non-empty visible-ASCII Idempotency-Key header.',
		instance,
		errors: validationErrors(issues) as ProblemValidationError[]
	});
}

function unsupportedMediaType(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:unsupported-media-type',
		title: 'Unsupported media type',
		status: 415,
		detail: 'This endpoint accepts application/json.',
		instance
	});
}

function bodyTooLarge(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:request-body-too-large',
		title: 'Request body too large',
		status: 413,
		detail: 'The retry command exceeded the allowed size.',
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

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:completion-artifact-retry-unavailable',
		title: 'Completion artifact retry unavailable',
		status: 503,
		detail: 'Completion artifact retry could not be processed.',
		instance
	});
}

function serviceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:completion-artifact-retry-service-unavailable',
		title: 'Completion artifact retry unavailable',
		status: 503,
		detail: 'The completion artifact retry command could not be processed.',
		instance
	});
}
