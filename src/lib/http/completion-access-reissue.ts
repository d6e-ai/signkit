import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import { COMPLETION_DELIVERY_ERROR_CODE_PATTERN } from '$lib/ports/completion-delivery-store';
import type {
	CompletionAccessReissueActor,
	CompletionAccessReissueApplicationPort,
	ReissueCompletionAccessInput,
	ReissueCompletionAccessResult
} from '$lib/application/completion-delivery/completion-access-reissue-service';
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
const recipientIdSchema: ZodType<string> = signkitIdentifierSchema;
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');
// The status read returns the failure generation as UTC ISO-8601 with
// millisecond (D1) or microsecond (PostgreSQL) precision; it is echoed back
// verbatim, so only that exact shape is accepted.
const expectedFailedAtSchema: ZodType<string> = z
	.string()
	.regex(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/,
		'expectedFailedAt must be the failedAt value from the completion delivery status read'
	);
const expectedErrorCodeSchema: ZodType<string> = z
	.string()
	.regex(COMPLETION_DELIVERY_ERROR_CODE_PATTERN);

export const completionAccessReissueBodySchema = z
	.object({
		grantAccess: z.literal(true),
		expectedDeliveryId: signkitIdentifierSchema,
		expectedAttempts: z.number().int().min(0).max(MAX_ATTEMPTS),
		expectedFailedAt: expectedFailedAtSchema,
		expectedErrorCode: expectedErrorCodeSchema
	})
	.strict();

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

/** The handler needs only `reissue`; a structural port keeps stubs honest. */
export type CompletionAccessReissuePort = Pick<CompletionAccessReissueApplicationPort, 'reissue'>;

export type CompletionAccessReissueServiceResolver = (
	context: ResolverContext
) => CompletionAccessReissuePort | null | Promise<CompletionAccessReissuePort | null>;

/**
 * Explicit, operator-confirmed recovery for one terminal failed completion
 * delivery -- never revives the terminal predecessor, only appends a fresh,
 * bounded-expiry successor chained to it. `grantAccess: true` and the full
 * expected-generation tuple must be present and match the current failed
 * generation exactly, so a stale or ambiguous confirmation screen can never
 * silently reissue the wrong generation.
 */
export function createCompletionAccessReissueHandler(
	resolveService: CompletionAccessReissueServiceResolver
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
		const recipientId = recipientIdSchema.safeParse(params.recipientId);
		if (!recipientId.success) {
			return validationProblem(
				url.pathname,
				'The recipient ID must be a UUID.',
				recipientId.error.issues
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
		const parsed = completionAccessReissueBodySchema.safeParse(body.value);
		if (!parsed.success) {
			return validationProblem(
				url.pathname,
				'The completion access reissue command did not match the required schema.',
				parsed.error.issues
			);
		}

		let service: CompletionAccessReissuePort | null;
		try {
			service = await resolveService({ locals, platform });
		} catch (error: unknown) {
			logError('completion_access_reissue_resolution_failed', error);
			service = null;
		}
		if (service === null) return unavailable(url.pathname);

		const actor: CompletionAccessReissueActor = {
			type: authorized.authority === 'api_key' ? 'agent' : 'user',
			id: authorized.id
		};
		const input: ReissueCompletionAccessInput = {
			envelopeId: envelopeId.data,
			recipientId: recipientId.data,
			idempotencyKey: idempotencyKey.data,
			expectedDeliveryId: parsed.data.expectedDeliveryId,
			expectedAttempts: parsed.data.expectedAttempts,
			expectedFailedAt: parsed.data.expectedFailedAt,
			expectedErrorCode: parsed.data.expectedErrorCode
		};

		try {
			const result: ReissueCompletionAccessResult = await service.reissue(actor, input);
			return reissueResponse(result, url.pathname);
		} catch (error: unknown) {
			logError('completion_access_reissue_failed', error);
			return serviceUnavailable(url.pathname);
		}
	};
}

function reissueResponse(result: ReissueCompletionAccessResult, instance: string): Response {
	if (result.outcome === 'published' || result.outcome === 'replayed') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(
			JSON.stringify({
				completionAccessReissue: {
					envelopeId: result.result.envelopeId,
					recipientId: result.result.recipientId,
					deliveryId: result.result.deliveryId,
					generation: result.result.generation,
					accessExpiresAt: result.result.accessExpiresAt,
					reissuedAt: result.result.reissuedAt
				}
			}),
			{ status: 200, headers }
		);
	}
	if (result.outcome === 'not_found') {
		return problemResponse({
			type: 'urn:signkit:problem:envelope-not-found',
			title: 'Envelope, recipient, or delivery not found',
			status: 404,
			detail: 'No matching envelope, recipient, or completion delivery was found.',
			instance
		});
	}
	if (result.outcome === 'not_eligible') {
		return problemResponse({
			type: 'urn:signkit:problem:completion-access-reissue-not-eligible',
			title: 'Completion access reissue not eligible',
			status: 409,
			detail: `This completion delivery is not eligible for reissue: ${result.reason}.`,
			instance
		});
	}
	if (result.outcome === 'stale_generation') {
		return problemResponse({
			type: 'urn:signkit:problem:completion-access-reissue-stale-generation',
			title: 'Completion delivery generation is stale',
			status: 409,
			detail: 'The expected delivery generation has moved on. Refresh the status and try again.',
			instance
		});
	}
	if (result.outcome === 'idempotency_conflict') {
		return problemResponse({
			type: 'urn:signkit:problem:idempotency-key-conflict',
			title: 'Idempotency key conflict',
			status: 409,
			detail: 'The provided Idempotency-Key was previously used with different command parameters.',
			instance
		});
	}
	if (result.outcome === 'artifact_unavailable') {
		return problemResponse({
			type: 'urn:signkit:problem:completion-access-reissue-artifact-unavailable',
			title: 'Completion artifact unavailable',
			status: 409,
			detail: 'The completion manifest and PDF must be published before access can be reissued.',
			instance
		});
	}
	return problemResponse({
		type: 'urn:signkit:problem:completion-access-reissue-integrity-error',
		title: 'Completion access reissue integrity error',
		status: 503,
		detail: 'The reissue publication failed integrity checks.',
		instance
	});
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
		detail: 'The reissue command exceeded the allowed size.',
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
		type: 'urn:signkit:problem:completion-access-reissue-unavailable',
		title: 'Completion access reissue unavailable',
		status: 503,
		detail: 'Completion access reissue could not be processed.',
		instance
	});
}

function serviceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:completion-access-reissue-service-unavailable',
		title: 'Completion access reissue unavailable',
		status: 503,
		detail: 'The completion access reissue command could not be processed.',
		instance
	});
}

function logError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({ event, message: error instanceof Error ? error.name : 'UnknownError' })
	);
}
