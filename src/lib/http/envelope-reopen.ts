import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import {
	InvalidReopenCommandError,
	type EnvelopeReopenApplicationPort,
	type ReopenEnvelopeInput,
	type ReopenEnvelopeResult
} from '$lib/application/envelopes/reopen';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import { authorizeScopedInstanceRequest, type AuthorizedApiActor } from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_BODY_BYTES: number = 64 * 1024;
const MAX_GENERATION: number = 2_147_483_647;
const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');
export const reopenSchema = z
	.object({
		expectedGeneration: z.number().int().min(1).max(MAX_GENERATION),
		expectedFieldGeneration: z
			.number()
			.int()
			.min(0)
			.max(MAX_GENERATION - 1),
		expectedReadyAuditEventId: signkitIdentifierSchema
	})
	.strict();

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type EnvelopeReopenApplicationResolver = (
	context: ResolverContext
) => EnvelopeReopenApplicationPort | null | Promise<EnvelopeReopenApplicationPort | null>;

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

export function createEnvelopeReopenHandler(
	resolveApplication: EnvelopeReopenApplicationResolver
): RequestHandler {
	return async ({ locals, params, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedInstanceRequest(
			locals,
			url.pathname,
			'drafts:write'
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
			return problemResponse({
				type: 'urn:signkit:problem:idempotency-key-required',
				title: 'Valid Idempotency-Key required',
				status: 400,
				detail: 'POST requests require one non-empty Idempotency-Key header.',
				instance: url.pathname,
				errors: validationErrors(idempotencyKey.error.issues)
			});
		}
		if (!acceptsJson(request)) {
			return problemResponse({
				type: 'urn:signkit:problem:unsupported-media-type',
				title: 'Unsupported media type',
				status: 415,
				detail: 'Reopen commands require an application/json request body.',
				instance: url.pathname
			});
		}

		const body: JsonBodyResult = await readJsonBody(request);
		if (!body.ok && body.reason === 'too_large') {
			return problemResponse({
				type: 'urn:signkit:problem:request-body-too-large',
				title: 'Request body too large',
				status: 413,
				detail: `The request body must not exceed ${MAX_BODY_BYTES} bytes.`,
				instance: url.pathname
			});
		}
		if (!body.ok) {
			return problemResponse({
				type: 'urn:signkit:problem:invalid-json',
				title: 'Invalid JSON',
				status: 400,
				detail: 'The request body must be valid JSON.',
				instance: url.pathname
			});
		}
		const parsed = reopenSchema.safeParse(body.value);
		if (!parsed.success) {
			return validationProblem(
				url.pathname,
				'The reopen command did not match the required schema.',
				parsed.error.issues
			);
		}

		let application: EnvelopeReopenApplicationPort | null;
		try {
			application = await resolveApplication({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'envelope_reopen_resolution_failed', message: errorMessage(error) })
			);
			application = null;
		}
		if (application === null) {
			return problemResponse({
				type: 'urn:signkit:problem:persistence-unavailable',
				title: 'Envelope persistence unavailable',
				status: 503,
				detail: 'The durable envelope store is not configured for this deployment.',
				instance: url.pathname
			});
		}

		const actor: EnvelopeRequestActor = {
			id: authorized.id,
			createdByUserId: authorized.createdByUserId,
			actorType: authorized.authority === 'api_key' ? 'agent' : 'user'
		};
		const input: ReopenEnvelopeInput = {
			idempotencyKey: idempotencyKey.data,
			expectedGeneration: parsed.data.expectedGeneration,
			expectedFieldGeneration: parsed.data.expectedFieldGeneration,
			expectedReadyAuditEventId: parsed.data.expectedReadyAuditEventId
		};
		try {
			const result: ReopenEnvelopeResult = await application.reopen(actor, envelopeId.data, input);
			return reopenResponse(result, url.pathname);
		} catch (error: unknown) {
			if (error instanceof InvalidReopenCommandError) {
				return problemResponse({
					type: 'urn:signkit:problem:validation-failed',
					title: 'Request validation failed',
					status: 400,
					detail: 'The reopen command did not match the required schema.',
					instance: url.pathname
				});
			}
			console.error(
				JSON.stringify({ event: 'envelope_reopen_failed', message: errorMessage(error) })
			);
			return problemResponse({
				type: 'urn:signkit:problem:service-unavailable',
				title: 'Envelope service unavailable',
				status: 503,
				detail: 'The envelope operation could not be completed.',
				instance: url.pathname
			});
		}
	};
}

function reopenResponse(result: ReopenEnvelopeResult, instance: string): Response {
	if (result.outcome === 'published' || result.outcome === 'replayed') {
		const replayed: boolean = result.outcome === 'replayed';
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (replayed) headers.set('idempotency-replayed', 'true');
		return new Response(JSON.stringify({ reopened: result.result, replayed }), {
			status: 200,
			headers
		});
	}
	const problems: Record<
		Exclude<ReopenEnvelopeResult['outcome'], 'published' | 'replayed'>,
		{
			type: string;
			title: string;
			status: number;
			detail: string;
		}
	> = {
		idempotency_conflict: {
			type: 'urn:signkit:problem:reopen-idempotency-conflict',
			title: 'Idempotency key conflict',
			status: 409,
			detail: 'The Idempotency-Key was already used for a different reopen command.'
		},
		not_found: {
			type: 'urn:signkit:problem:envelope-not-found',
			title: 'Envelope not found',
			status: 404,
			detail: 'No envelope was found.'
		},
		not_ready: {
			type: 'urn:signkit:problem:envelope-not-ready',
			title: 'Envelope is not ready',
			status: 409,
			detail: 'Only a ready envelope that has not been sent can be returned to draft.'
		},
		generation_conflict: {
			type: 'urn:signkit:problem:draft-generation-conflict',
			title: 'Draft generation conflict',
			status: 409,
			detail: 'The draft changed after the caller read it.'
		},
		field_generation_conflict: {
			type: 'urn:signkit:problem:field-generation-conflict',
			title: 'Field generation conflict',
			status: 409,
			detail: 'The field set changed after the caller read it.'
		},
		audit_conflict: {
			type: 'urn:signkit:problem:audit-head-conflict',
			title: 'Audit head conflict',
			status: 409,
			detail: 'Another envelope command changed the audit head before this command was published.'
		},
		integrity_error: {
			type: 'urn:signkit:problem:reopen-integrity-error',
			title: 'Envelope integrity check failed',
			status: 503,
			detail: 'The reopen command could not prove a consistent ready envelope and audit head.'
		}
	};
	return problemResponse({ ...problems[result.outcome], instance });
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

function validationProblem(
	instance: string,
	detail: string,
	issues: readonly ZodIssue[]
): Response {
	return problemResponse({
		type: 'urn:signkit:problem:validation-failed',
		title: 'Request validation failed',
		status: 400,
		detail,
		instance,
		errors: validationErrors(issues)
	});
}

function validationErrors(issues: readonly ZodIssue[]): readonly ProblemValidationError[] {
	return issues.map((issue: ZodIssue): ProblemValidationError => ({
		path: issue.path.length === 0 ? '$' : issue.path.join('.'),
		message: issue.message
	}));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'unknown error';
}

function acceptsJson(request: Request): boolean {
	const contentType: string | null = request.headers.get('content-type');
	return contentType?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}
