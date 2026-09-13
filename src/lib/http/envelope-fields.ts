import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import { fieldTypes } from '$lib/domain/envelope';
import type {
	EnvelopeFieldApplicationPort,
	PlaceFieldsInput,
	PlaceFieldsResult
} from '$lib/application/envelopes/fields';
import { InvalidFieldPlacementError } from '$lib/application/envelopes/fields';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import {
	authorizeScopedOrganizationRequest,
	type AuthorizedApiActor
} from './api-key-authorization';
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
const documentPathSchema: ZodType<string> = z
	.string()
	.max(240)
	.regex(/^documents\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/, 'Document path must be under documents/')
	.refine((value: string): boolean => !value.includes('..'), {
		message: 'Document paths must not contain ..'
	});
const geometrySchema = z
	.object({
		page: z.number().int().min(1).max(100_000),
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
		width: z.number().gt(0).max(1),
		height: z.number().gt(0).max(1)
	})
	.strict();
const fieldSchema = z
	.object({
		recipientId: signkitIdentifierSchema,
		documentPath: documentPathSchema,
		fieldType: z.enum(fieldTypes),
		label: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.refine((value: string): boolean => !hasControlCharacter(value), {
				message: 'Field labels must not contain control characters'
			}),
		required: z.boolean(),
		position: z.number().int().min(0).max(100_000),
		geometry: geometrySchema.nullable().optional()
	})
	.strict();
const fieldsSchema = z
	.object({
		expectedGeneration: z.number().int().min(1).max(MAX_GENERATION),
		expectedFieldGeneration: z
			.number()
			.int()
			.min(0)
			.max(MAX_GENERATION - 1),
		fields: z.array(fieldSchema).min(1).max(50)
	})
	.strict()
	.superRefine((value, context): void => {
		const locators: Set<string> = new Set<string>();
		for (const [index, field] of value.fields.entries()) {
			const locator: string = [
				field.recipientId.toLowerCase(),
				field.documentPath,
				field.position
			].join('\u0000');
			if (locators.has(locator)) {
				context.addIssue({
					code: 'custom',
					path: ['fields', index],
					message: 'Field declarations must not repeat the same recipient/document/position.'
				});
			}
			locators.add(locator);
		}
	});

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type EnvelopeFieldApplicationResolver = (
	context: ResolverContext
) => EnvelopeFieldApplicationPort | null | Promise<EnvelopeFieldApplicationPort | null>;

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

export function createEnvelopeFieldsHandler(
	resolveApplication: EnvelopeFieldApplicationResolver
): RequestHandler {
	return async ({ locals, params, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedOrganizationRequest(
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
				detail: 'Field placement commands require an application/json request body.',
				instance: url.pathname
			});
		}

		let body: JsonBodyResult;
		try {
			body = await readJsonBody(request);
		} catch {
			body = { ok: false, reason: 'invalid' };
		}
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
		const parsed = fieldsSchema.safeParse(body.value);
		if (!parsed.success) {
			return validationProblem(
				url.pathname,
				'The field placement command did not match the required schema.',
				parsed.error.issues
			);
		}

		let application: EnvelopeFieldApplicationPort | null;
		try {
			application = await resolveApplication({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'envelope_fields_resolution_failed', message: errorMessage(error) })
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
			organizationName: authorized.organizationName,
			actorType: authorized.authority === 'api_key' ? 'agent' : 'user'
		};
		const input: PlaceFieldsInput = {
			idempotencyKey: idempotencyKey.data,
			expectedGeneration: parsed.data.expectedGeneration,
			expectedFieldGeneration: parsed.data.expectedFieldGeneration,
			fields: parsed.data.fields.map((field) => ({
				...field,
				documentPath: field.documentPath as `documents/${string}.md`
			}))
		};
		try {
			const result: PlaceFieldsResult = await application.place(actor, envelopeId.data, input);
			return fieldsResponse(result, url.pathname);
		} catch (error: unknown) {
			if (error instanceof InvalidFieldPlacementError) {
				return problemResponse({
					type: 'urn:signkit:problem:validation-failed',
					title: 'Request validation failed',
					status: 400,
					detail: 'The field placement command did not match the required schema.',
					instance: url.pathname,
					errors: [{ path: '$', message: error.message }]
				});
			}
			console.error(
				JSON.stringify({ event: 'envelope_fields_failed', message: errorMessage(error) })
			);
			return problemResponse({
				type: 'urn:signkit:problem:service-unavailable',
				title: 'Envelope service unavailable',
				status: 503,
				detail: 'The field placement command could not be completed.',
				instance: url.pathname
			});
		}
	};
}

function fieldsResponse(result: PlaceFieldsResult, instance: string): Response {
	if (result.outcome === 'published' || result.outcome === 'replayed') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(JSON.stringify({ fields: result.result }), { status: 200, headers });
	}
	const problems: Record<
		Exclude<PlaceFieldsResult['outcome'], 'published' | 'replayed'>,
		{
			type: string;
			title: string;
			status: number;
			detail: string;
		}
	> = {
		idempotency_conflict: {
			type: 'urn:signkit:problem:fields-idempotency-conflict',
			title: 'Idempotency key conflict',
			status: 409,
			detail: 'The Idempotency-Key was already used for a different field placement command.'
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
			detail: 'Signing fields can only be placed on an envelope that is ready, before it is sent.'
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
		invalid_document: {
			type: 'urn:signkit:problem:field-invalid-document',
			title: 'Field document not found',
			status: 422,
			detail: 'A field referenced a document path that does not exist in the current draft.'
		},
		invalid_recipient: {
			type: 'urn:signkit:problem:field-invalid-recipient',
			title: 'Field recipient invalid',
			status: 422,
			detail: 'A field referenced a recipient who is not a signer on this envelope.'
		},
		integrity_error: {
			type: 'urn:signkit:problem:fields-integrity-error',
			title: 'Field placement integrity check failed',
			status: 503,
			detail: 'The field placement command could not prove a consistent draft and audit head.'
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

function hasControlCharacter(value: string): boolean {
	for (let index: number = 0; index < value.length; index += 1) {
		const code: number = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}
