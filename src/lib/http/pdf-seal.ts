import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import type {
	PdfSealApiApplicationPort,
	PublicPdfSealStatus,
	RequestPdfSealApplicationResult
} from '$lib/application/pdf-seals/pdf-seal-api';
import type { PdfSealRequestPolicy } from '$lib/application/pdf-seals/pdf-seal-runtime';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
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
const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');
const requestSchema = z.object({ requestedProfile: z.enum(['pades-b-b', 'pades-b-t']) }).strict();

export interface PdfSealApiRuntime {
	application: PdfSealApiApplicationPort;
	requestPolicy: PdfSealRequestPolicy | null;
}

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type PdfSealApiRuntimeResolver = (
	context: ResolverContext
) => PdfSealApiRuntime | null | Promise<PdfSealApiRuntime | null>;

export function createPdfSealStatusHandler(
	resolveRuntime: PdfSealApiRuntimeResolver
): RequestHandler {
	return async ({ locals, params, platform, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedInstanceRequest(
			locals,
			url.pathname,
			'envelopes:read'
		);
		if (authorized instanceof Response) return authorized;
		const envelopeId = envelopeIdSchema.safeParse(params.envelopeId);
		if (!envelopeId.success) return invalidEnvelopeId(url.pathname, envelopeId.error.issues);

		const runtime: PdfSealApiRuntime | Response = await resolveApiRuntime(
			resolveRuntime,
			{ locals, platform },
			url.pathname
		);
		if (runtime instanceof Response) return runtime;
		try {
			const status: PublicPdfSealStatus | null = await runtime.application.findStatus(
				envelopeId.data,
				runtime.requestPolicy !== null
			);
			if (status === null) return envelopeNotFound(url.pathname);
			return Response.json({ pdfSeal: status }, { headers: { 'cache-control': 'no-store' } });
		} catch (error: unknown) {
			logApiError('pdf_seal_status_failed', error);
			return unavailable(url.pathname);
		}
	};
}

export function createPdfSealRequestHandler(
	resolveRuntime: PdfSealApiRuntimeResolver
): RequestHandler {
	return async ({ locals, params, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedInstanceRequest(
			locals,
			url.pathname,
			'envelopes:send'
		);
		if (authorized instanceof Response) return authorized;
		const envelopeId = envelopeIdSchema.safeParse(params.envelopeId);
		if (!envelopeId.success) return invalidEnvelopeId(url.pathname, envelopeId.error.issues);
		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success) {
			return problemResponse({
				type: 'urn:signkit:problem:idempotency-key-required',
				title: 'Valid Idempotency-Key required',
				status: 400,
				detail: 'POST requests require one non-empty visible-ASCII Idempotency-Key header.',
				instance: url.pathname,
				errors: validationErrors(idempotencyKey.error.issues) as ProblemValidationError[]
			});
		}
		if (!acceptsJson(request)) {
			return problemResponse({
				type: 'urn:signkit:problem:unsupported-media-type',
				title: 'Unsupported media type',
				status: 415,
				detail: 'PDF seal requests require an application/json request body.',
				instance: url.pathname
			});
		}
		const body: JsonBodyResult = await readJsonBody(request, MAX_BODY_BYTES);
		if (!body.ok) return invalidBody(url.pathname, body.reason);
		const parsed = requestSchema.safeParse(body.value);
		if (!parsed.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-error',
				title: 'Validation failed',
				status: 400,
				detail: 'The PDF seal request did not match the required schema.',
				instance: url.pathname,
				errors: validationErrors(parsed.error.issues) as ProblemValidationError[]
			});
		}

		const runtime: PdfSealApiRuntime | Response = await resolveApiRuntime(
			resolveRuntime,
			{ locals, platform },
			url.pathname
		);
		if (runtime instanceof Response) return runtime;
		if (runtime.requestPolicy === null) return disabled(url.pathname);
		if (parsed.data.requestedProfile !== runtime.requestPolicy.requestedProfile) {
			return problemResponse({
				type: 'urn:signkit:problem:pdf-seal-profile-unavailable',
				title: 'PDF seal profile unavailable',
				status: 409,
				detail: 'The requested PDF seal profile is not enabled for this instance.',
				instance: url.pathname
			});
		}

		const actor: EnvelopeRequestActor = {
			id: authorized.id,
			createdByUserId: authorized.createdByUserId,
			actorType: authorized.authority === 'api_key' ? 'agent' : 'user'
		};
		try {
			return requestResponse(
				await runtime.application.request(actor, envelopeId.data, {
					idempotencyKey: idempotencyKey.data,
					requestedProfile: parsed.data.requestedProfile,
					policy: runtime.requestPolicy
				}),
				url.pathname
			);
		} catch (error: unknown) {
			logApiError('pdf_seal_request_failed', error);
			return unavailable(url.pathname);
		}
	};
}

async function resolveApiRuntime(
	resolver: PdfSealApiRuntimeResolver,
	context: ResolverContext,
	instance: string
): Promise<PdfSealApiRuntime | Response> {
	try {
		return (await resolver(context)) ?? unavailable(instance);
	} catch (error: unknown) {
		logApiError('pdf_seal_api_resolution_failed', error);
		return unavailable(instance);
	}
}

function requestResponse(result: RequestPdfSealApplicationResult, instance: string): Response {
	if (
		result.outcome === 'requested' ||
		result.outcome === 'replayed' ||
		result.outcome === 'existing'
	) {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(JSON.stringify({ pdfSeal: result.request }), { status: 202, headers });
	}
	const problems = {
		idempotency_conflict: {
			type: 'urn:signkit:problem:pdf-seal-idempotency-conflict',
			title: 'Idempotency key conflict',
			detail: 'The Idempotency-Key was already used for a different PDF seal request.'
		},
		not_found: {
			type: 'urn:signkit:problem:envelope-not-found',
			title: 'Envelope not found',
			detail: 'No envelope was found.'
		},
		source_unavailable: {
			type: 'urn:signkit:problem:pdf-seal-source-unavailable',
			title: 'Completion PDF unavailable',
			detail: 'An attested completion PDF must be published before a seal can be requested.'
		}
	} as const;
	const problem = problems[result.outcome];
	return problemResponse({
		...problem,
		status: result.outcome === 'not_found' ? 404 : 409,
		instance
	});
}

function invalidEnvelopeId(instance: string, issues: readonly ZodIssue[]): Response {
	return problemResponse({
		type: 'urn:signkit:problem:validation-error',
		title: 'Validation failed',
		status: 400,
		detail: 'The envelope ID must be a UUID.',
		instance,
		errors: validationErrors(issues) as ProblemValidationError[]
	});
}

function invalidBody(instance: string, reason: 'invalid' | 'too_large'): Response {
	return problemResponse(
		reason === 'too_large'
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

function envelopeNotFound(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:envelope-not-found',
		title: 'Envelope not found',
		status: 404,
		detail: 'No envelope was found.',
		instance
	});
}

function disabled(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:pdf-seal-disabled',
		title: 'PDF sealing disabled',
		status: 409,
		detail: 'PDF sealing is not enabled for this instance.',
		instance
	});
}

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:pdf-seal-unavailable',
		title: 'PDF seal service unavailable',
		status: 503,
		detail: 'The PDF seal request service is unavailable.',
		instance
	});
}

function logApiError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({ event, message: error instanceof Error ? error.name : 'UnknownError' })
	);
}
