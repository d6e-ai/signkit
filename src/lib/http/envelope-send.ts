import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import type {
	EnvelopeSendApplicationPort,
	SendEnvelopeInput,
	SendEnvelopeResult
} from '$lib/application/envelopes/send';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import {
	authorizeScopedOrganizationRequest,
	type AuthorizedApiActor
} from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_BODY_BYTES: number = 16 * 1024;
const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');
const sendSchema = z
	.object({
		expectedGeneration: z.number().int().min(1).max(2_147_483_647),
		expectedReadyAuditEventId: signkitIdentifierSchema
	})
	.strict();

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}
export type EnvelopeSendApplicationResolver = (
	context: ResolverContext
) => EnvelopeSendApplicationPort | null | Promise<EnvelopeSendApplicationPort | null>;
type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

export function createEnvelopeSendHandler(
	resolveApplication: EnvelopeSendApplicationResolver
): RequestHandler {
	return async ({ locals, params, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedOrganizationRequest(
			locals,
			url.pathname,
			'envelopes:send'
		);
		if (authorized instanceof Response) return authorized;
		const envelopeId = envelopeIdSchema.safeParse(params.envelopeId);
		if (!envelopeId.success)
			return validationProblem(
				url.pathname,
				'The envelope ID must be a UUID.',
				envelopeId.error.issues
			);
		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success)
			return problemResponse({
				type: 'urn:signkit:problem:idempotency-key-required',
				title: 'Valid Idempotency-Key required',
				status: 400,
				detail: 'POST requests require one non-empty Idempotency-Key header.',
				instance: url.pathname,
				errors: validationErrors(idempotencyKey.error.issues)
			});
		if (!acceptsJson(request))
			return problemResponse({
				type: 'urn:signkit:problem:unsupported-media-type',
				title: 'Unsupported media type',
				status: 415,
				detail: 'Send commands require an application/json request body.',
				instance: url.pathname
			});
		const body: JsonBodyResult = await readJsonBody(request);
		if (!body.ok)
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
		const parsed = sendSchema.safeParse(body.value);
		if (!parsed.success)
			return validationProblem(
				url.pathname,
				'The send command did not match the required schema.',
				parsed.error.issues
			);
		let application: EnvelopeSendApplicationPort | null;
		try {
			application = await resolveApplication({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'envelope_send_resolution_failed', message: errorMessage(error) })
			);
			application = null;
		}
		if (application === null)
			return problemResponse({
				type: 'urn:signkit:problem:persistence-unavailable',
				title: 'Envelope persistence unavailable',
				status: 503,
				detail: 'The durable envelope store and delivery encryption key must be configured.',
				instance: url.pathname
			});
		const actor: EnvelopeRequestActor = {
			id: authorized.id,
			organizationId: authorized.organizationId,
			organizationName: authorized.organizationName,
			actorType: authorized.authority === 'api_key' ? 'agent' : 'user'
		};
		const input: SendEnvelopeInput = {
			idempotencyKey: idempotencyKey.data,
			expectedGeneration: parsed.data.expectedGeneration,
			expectedReadyAuditEventId: parsed.data.expectedReadyAuditEventId
		};
		try {
			return sendResponse(await application.send(actor, envelopeId.data, input), url.pathname);
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'envelope_send_failed', message: errorMessage(error) })
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

function sendResponse(result: SendEnvelopeResult, instance: string): Response {
	if (result.outcome === 'published' || result.outcome === 'replayed') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(JSON.stringify({ sent: result.result }), { status: 202, headers });
	}
	const problems: Record<
		Exclude<SendEnvelopeResult['outcome'], 'published' | 'replayed'>,
		{ type: string; title: string; status: number; detail: string }
	> = {
		idempotency_conflict: {
			type: 'urn:signkit:problem:send-idempotency-conflict',
			title: 'Idempotency key conflict',
			status: 409,
			detail: 'The Idempotency-Key was already used for a different send command.'
		},
		not_found: {
			type: 'urn:signkit:problem:envelope-not-found',
			title: 'Envelope not found',
			status: 404,
			detail: 'No envelope was found in the authorized organization.'
		},
		not_ready: {
			type: 'urn:signkit:problem:envelope-not-ready',
			title: 'Envelope is not ready',
			status: 409,
			detail: 'Only a ready envelope can be sent.'
		},
		generation_conflict: {
			type: 'urn:signkit:problem:draft-generation-conflict',
			title: 'Draft generation conflict',
			status: 409,
			detail: 'The draft generation does not match the ready envelope.'
		},
		audit_conflict: {
			type: 'urn:signkit:problem:audit-head-conflict',
			title: 'Audit head conflict',
			status: 409,
			detail: 'The ready audit event is no longer the envelope audit head.'
		},
		integrity_error: {
			type: 'urn:signkit:problem:send-integrity-error',
			title: 'Envelope integrity check failed',
			status: 503,
			detail: 'The send command could not prove a consistent recipient graph and audit head.'
		}
	};
	return problemResponse({ ...problems[result.outcome], instance });
}

async function readJsonBody(request: Request): Promise<JsonBodyResult> {
	const declared: string | null = request.headers.get('content-length');
	if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > MAX_BODY_BYTES)
		return { ok: false, reason: 'too_large' };
	if (request.body === null) return { ok: false, reason: 'invalid' };
	const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total: number = 0;
	try {
		while (true) {
			const read: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (read.done) break;
			total += read.value.byteLength;
			if (total > MAX_BODY_BYTES) {
				await reader.cancel();
				return { ok: false, reason: 'too_large' };
			}
			chunks.push(read.value);
		}
	} catch {
		return { ok: false, reason: 'invalid' };
	}
	const bytes: Uint8Array = new Uint8Array(total);
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
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown error';
}
