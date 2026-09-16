import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import type {
	EnvelopeVoidApplicationPort,
	VoidEnvelopeInput,
	VoidEnvelopeResult
} from '$lib/application/envelopes/void';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import { authorizeScopedInstanceRequest, type AuthorizedApiActor } from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_BODY_BYTES: number = 4 * 1024;
const MAX_GENERATION: number = 2_147_483_647;
const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');
const voidSchema = z
	.object({
		expectedStatus: z.enum(['draft', 'ready', 'sent', 'in_progress']),
		expectedGeneration: z.number().int().min(0).max(MAX_GENERATION)
	})
	.strict();

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type EnvelopeVoidApplicationResolver = (
	context: ResolverContext
) => EnvelopeVoidApplicationPort | null | Promise<EnvelopeVoidApplicationPort | null>;

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

export function createEnvelopeVoidHandler(
	resolveApplication: EnvelopeVoidApplicationResolver
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
		if (!idempotencyKey.success)
			return idempotencyRequired(url.pathname, idempotencyKey.error.issues);
		if (!acceptsJson(request)) return unsupportedMediaType(url.pathname);

		const body: JsonBodyResult = await readJsonBody(request);
		if (!body.ok) {
			return body.reason === 'too_large' ? bodyTooLarge(url.pathname) : invalidJson(url.pathname);
		}
		const parsed = voidSchema.safeParse(body.value);
		if (!parsed.success) {
			return validationProblem(
				url.pathname,
				'The void command did not match the required schema.',
				parsed.error.issues
			);
		}

		let application: EnvelopeVoidApplicationPort | null;
		try {
			application = await resolveApplication({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'envelope_void_resolution_failed', message: errorMessage(error) })
			);
			application = null;
		}
		if (application === null) return persistenceUnavailable(url.pathname);

		const actor: EnvelopeRequestActor = {
			id: authorized.id,
			createdByUserId: authorized.createdByUserId,
			actorType: authorized.authority === 'api_key' ? 'agent' : 'user'
		};
		const input: VoidEnvelopeInput = {
			idempotencyKey: idempotencyKey.data,
			expectedStatus: parsed.data.expectedStatus,
			expectedGeneration: parsed.data.expectedGeneration
		};
		try {
			return voidResponse(
				await application.voidEnvelope(actor, envelopeId.data, input),
				url.pathname
			);
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'envelope_void_failed', message: errorMessage(error) })
			);
			return serviceUnavailable(url.pathname);
		}
	};
}

function voidResponse(result: VoidEnvelopeResult, instance: string): Response {
	if (result.outcome === 'published' || result.outcome === 'replayed') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(JSON.stringify({ voided: result.result }), { status: 200, headers });
	}

	const problems: Record<
		Exclude<VoidEnvelopeResult['outcome'], 'published' | 'replayed'>,
		{ type: string; title: string; status: number; detail: string }
	> = {
		idempotency_conflict: {
			type: 'urn:signkit:problem:void-idempotency-conflict',
			title: 'Idempotency key conflict',
			status: 409,
			detail: 'The Idempotency-Key was already used for a different void command.'
		},
		not_found: {
			type: 'urn:signkit:problem:envelope-not-found',
			title: 'Envelope not found',
			status: 404,
			detail: 'No envelope was found.'
		},
		not_voidable: {
			type: 'urn:signkit:problem:envelope-not-voidable',
			title: 'Envelope cannot be voided',
			status: 409,
			detail: 'Completed, declined, or already voided envelopes cannot be voided.'
		},
		status_conflict: {
			type: 'urn:signkit:problem:envelope-void-status-conflict',
			title: 'Envelope state conflict',
			status: 409,
			detail: 'The envelope status changed after the caller read it.'
		},
		generation_conflict: {
			type: 'urn:signkit:problem:envelope-void-generation-conflict',
			title: 'Envelope generation conflict',
			status: 409,
			detail: 'The envelope generation changed after the caller read it.'
		},
		audit_conflict: {
			type: 'urn:signkit:problem:audit-head-conflict',
			title: 'Audit head conflict',
			status: 409,
			detail: 'Another envelope command changed the audit head before the void was recorded.'
		},
		delivery_in_flight: {
			type: 'urn:signkit:problem:envelope-void-delivery-in-flight',
			title: 'Invitation delivery in progress',
			status: 409,
			detail: 'An invitation delivery is currently in progress. Retry the void command shortly.'
		},
		integrity_error: {
			type: 'urn:signkit:problem:void-integrity-error',
			title: 'Envelope integrity check failed',
			status: 503,
			detail: 'The void command could not prove a consistent envelope and audit state.'
		}
	};
	const headers: HeadersInit | undefined =
		result.outcome === 'delivery_in_flight' || result.outcome === 'audit_conflict'
			? { 'retry-after': '1' }
			: undefined;
	return problemResponse({ ...problems[result.outcome], instance }, headers);
}

async function readJsonBody(request: Request): Promise<JsonBodyResult> {
	const contentLength: string | null = request.headers.get('content-length');
	if (contentLength !== null) {
		const declaredBytes: number = Number(contentLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
			return { ok: false, reason: 'too_large' };
		}
	}
	if (request.body === null) return { ok: false, reason: 'invalid' };

	const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes: number = 0;
	try {
		while (true) {
			const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (next.done) break;
			totalBytes += next.value.byteLength;
			if (totalBytes > MAX_BODY_BYTES) {
				await reader.cancel('request body exceeded the configured limit');
				return { ok: false, reason: 'too_large' };
			}
			chunks.push(next.value);
		}
	} catch {
		return { ok: false, reason: 'invalid' };
	} finally {
		reader.releaseLock();
	}

	const bytes: Uint8Array = new Uint8Array(totalBytes);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return {
			ok: true,
			value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
		};
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}

function acceptsJson(request: Request): boolean {
	return (
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
		'application/json'
	);
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
		errors: validationErrors(issues)
	});
}

function validationErrors(issues: readonly ZodIssue[]): ProblemValidationError[] {
	return issues.map((issue: ZodIssue): ProblemValidationError => ({
		path: issue.path.length === 0 ? '$' : issue.path.join('.'),
		message: issue.message
	}));
}

function idempotencyRequired(instance: string, issues: readonly ZodIssue[]): Response {
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
		detail: 'Void commands require an application/json request body.',
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

function bodyTooLarge(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:request-body-too-large',
		title: 'Request body too large',
		status: 413,
		detail: `The request body must not exceed ${MAX_BODY_BYTES} bytes.`,
		instance
	});
}

function persistenceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:persistence-unavailable',
		title: 'Envelope persistence unavailable',
		status: 503,
		detail: 'The durable envelope store is not configured for this deployment.',
		instance
	});
}

function serviceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:service-unavailable',
		title: 'Envelope service unavailable',
		status: 503,
		detail: 'The envelope operation could not be completed.',
		instance
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown error';
}
