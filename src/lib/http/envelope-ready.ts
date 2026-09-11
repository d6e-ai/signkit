import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import type {
	EnvelopeReadyApplicationPort,
	ReadyEnvelopeInput,
	ReadyEnvelopeResult
} from '$lib/application/envelopes/ready';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import {
	authorizeOrganizationRequest,
	type AuthorizedRequestActor
} from './organization-authorization';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_BODY_BYTES: number = 64 * 1024;
const MAX_GENERATION: number = 2_147_483_647;
const envelopeIdSchema: ZodType<string> = z.string().uuid();
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');
const recipientSchema = z
	.object({
		email: z.string().trim().email().max(320),
		name: z.string().trim().min(1).max(200),
		role: z.enum(['signer', 'approver', 'viewer', 'prefill', 'cc']),
		locale: z.enum(['en', 'ja']),
		routingOrder: z.number().int().min(1).max(1000)
	})
	.strict();
const readySchema = z
	.object({
		expectedGeneration: z.number().int().min(1).max(MAX_GENERATION),
		recipients: z.array(recipientSchema).min(1).max(50)
	})
	.strict()
	.superRefine((value, context): void => {
		const emails: Set<string> = new Set<string>();
		for (const [index, recipient] of value.recipients.entries()) {
			const email: string = recipient.email.toLowerCase();
			if (emails.has(email)) {
				context.addIssue({
					code: 'custom',
					path: ['recipients', index, 'email'],
					message: 'Recipient email addresses must be unique within an envelope.'
				});
			}
			emails.add(email);
		}
		if (
			!value.recipients.some((recipient): boolean =>
				['signer', 'approver'].includes(recipient.role)
			)
		) {
			context.addIssue({
				code: 'custom',
				path: ['recipients'],
				message: 'At least one signer or approver is required.'
			});
		}
	});

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type EnvelopeReadyApplicationResolver = (
	context: ResolverContext
) => EnvelopeReadyApplicationPort | null | Promise<EnvelopeReadyApplicationPort | null>;

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

export function createEnvelopeReadyHandler(
	resolveApplication: EnvelopeReadyApplicationResolver
): RequestHandler {
	return async ({ locals, params, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedRequestActor | Response = authorizeOrganizationRequest(
			locals,
			url.pathname
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
				detail: 'Ready commands require an application/json request body.',
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
		const parsed = readySchema.safeParse(body.value);
		if (!parsed.success) {
			return validationProblem(
				url.pathname,
				'The ready command did not match the required schema.',
				parsed.error.issues
			);
		}

		let application: EnvelopeReadyApplicationPort | null;
		try {
			application = await resolveApplication({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'envelope_ready_resolution_failed', message: errorMessage(error) })
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
			organizationId: authorized.organizationId,
			organizationName: authorized.organizationName
		};
		const input: ReadyEnvelopeInput = {
			idempotencyKey: idempotencyKey.data,
			expectedGeneration: parsed.data.expectedGeneration,
			recipients: parsed.data.recipients
		};
		try {
			const result: ReadyEnvelopeResult = await application.ready(actor, envelopeId.data, input);
			return readyResponse(result, url.pathname);
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'envelope_ready_failed', message: errorMessage(error) })
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

function readyResponse(result: ReadyEnvelopeResult, instance: string): Response {
	if (result.outcome === 'published' || result.outcome === 'replayed') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(JSON.stringify({ ready: result.result }), { status: 200, headers });
	}
	const problems: Record<
		Exclude<ReadyEnvelopeResult['outcome'], 'published' | 'replayed'>,
		{
			type: string;
			title: string;
			status: number;
			detail: string;
		}
	> = {
		idempotency_conflict: {
			type: 'urn:signkit:problem:ready-idempotency-conflict',
			title: 'Idempotency key conflict',
			status: 409,
			detail: 'The Idempotency-Key was already used for a different ready command.'
		},
		not_found: {
			type: 'urn:signkit:problem:envelope-not-found',
			title: 'Envelope not found',
			status: 404,
			detail: 'No envelope was found in the authorized organization.'
		},
		immutable: {
			type: 'urn:signkit:problem:envelope-not-draft',
			title: 'Envelope is not mutable',
			status: 409,
			detail: 'Only a draft envelope can be prepared for sending.'
		},
		generation_conflict: {
			type: 'urn:signkit:problem:draft-generation-conflict',
			title: 'Draft generation conflict',
			status: 409,
			detail: 'The draft changed after the caller read it.'
		},
		audit_conflict: {
			type: 'urn:signkit:problem:audit-head-conflict',
			title: 'Audit head conflict',
			status: 409,
			detail: 'Another envelope command changed the audit head before this command was published.'
		},
		empty_draft: {
			type: 'urn:signkit:problem:empty-draft',
			title: 'Draft has no committed documents',
			status: 409,
			detail: 'Commit at least one Markdown document before preparing the envelope.'
		},
		integrity_error: {
			type: 'urn:signkit:problem:ready-integrity-error',
			title: 'Envelope integrity check failed',
			status: 503,
			detail: 'The ready command could not prove a consistent draft and audit head.'
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
