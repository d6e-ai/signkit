import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { z, type ZodType } from 'zod';
import {
	InvalidSignInputError,
	type RecipientSignedApplicationPort,
	type RecipientSignedResult
} from '$lib/application/signing/recipient-signed';
import { readRecipientSessionCookie } from '$lib/server/recipient-session';
import { boundEnvelopeId } from './envelope-binding';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';
import { recipientBearerToken, type RecipientHttpMode } from './recipient-bearer';
import {
	exchangeCompletedReceiptCookie,
	type RecipientCompletedReceiptHandlerOptions
} from './recipient-completed-receipt';

const MAX_VALUES: number = 50;
const MAX_VALUE_CHARS: number = 4000;
// Includes JSON escaping overhead for a schema-valid set of 50 maximum-length values.
const MAX_BODY_BYTES: number = 2 * 1024 * 1024;
const MAX_GENERATION: number = 2_147_483_647;
const idSchema: ZodType<string> = signkitIdentifierSchema;
const fieldValueSchema = z
	.object({
		fieldId: signkitIdentifierSchema,
		value: z.union([z.string().max(MAX_VALUE_CHARS), z.boolean()])
	})
	.strict();
const bodySchema = z
	.object({
		envelopeId: idSchema,
		recipientId: idSchema,
		expectedFieldGeneration: z
			.number()
			.int()
			.min(0)
			.max(MAX_GENERATION - 1),
		values: z.array(fieldValueSchema).max(MAX_VALUES)
	})
	.strict();
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/);

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type RecipientSignedApplicationResolver = (
	context: ResolverContext
) => RecipientSignedApplicationPort | null | Promise<RecipientSignedApplicationPort | null>;

export type RecipientSessionUnsealer = (
	cookie: string,
	envelopeId: string
) => Promise<string | null>;

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

export function createRecipientSignedHandler(
	resolveApplication: RecipientSignedApplicationResolver,
	unsealSession: RecipientSessionUnsealer,
	options?: RecipientCompletedReceiptHandlerOptions,
	mode: RecipientHttpMode = 'browser'
): RequestHandler {
	return async ({ cookies, platform, request, url }): Promise<Response> => {
		if (mode === 'browser' && request.headers.get('origin') !== url.origin)
			return crossOriginDenied(url.pathname);
		const explicitToken: string | null = mode === 'bearer' ? recipientBearerToken(request) : null;
		if (mode === 'bearer' && explicitToken === null) return accessNotFound(url.pathname);

		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success) return idempotencyRequired(url.pathname);
		if (!acceptsJson(request)) return unsupportedMediaType(url.pathname);

		const body: JsonBodyResult = await readJsonBody(request);
		if (!body.ok) {
			return body.reason === 'too_large' ? bodyTooLarge(url.pathname) : invalidJson(url.pathname);
		}
		const parsed = bodySchema.safeParse(body.value);
		if (!parsed.success) return invalidCommand(url.pathname);
		const envelopeId: string | null = boundEnvelopeId(
			parsed.data.envelopeId,
			url.searchParams.get('envelopeId')
		);
		if (envelopeId === null) return invalidCommand(url.pathname);

		let token: string | null;
		if (mode === 'bearer') {
			token = explicitToken;
		} else {
			const sealed: string | undefined = readRecipientSessionCookie(cookies, envelopeId);
			if (sealed === undefined) return accessNotFound(url.pathname);
			try {
				token = await unsealSession(sealed, envelopeId);
			} catch {
				console.error(JSON.stringify({ event: 'recipient_signed_session_failed' }));
				return unavailable(url.pathname);
			}
		}
		if (token === null) return accessNotFound(url.pathname);

		let application: RecipientSignedApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch {
			console.error(JSON.stringify({ event: 'recipient_signed_resolution_failed' }));
			return unavailable(url.pathname);
		}
		if (application === null) return unavailable(url.pathname);

		try {
			const result: RecipientSignedResult = await application.sign({
				token,
				expectedEnvelopeId: envelopeId,
				expectedRecipientId: parsed.data.recipientId,
				expectedFieldGeneration: parsed.data.expectedFieldGeneration,
				idempotencyKey: idempotencyKey.data,
				values: parsed.data.values
			});
			return await resultResponse(
				result,
				token,
				envelopeId,
				idempotencyKey.data,
				url,
				platform,
				mode === 'browser' ? cookies : null,
				options
			);
		} catch (error: unknown) {
			if (error instanceof InvalidSignInputError) return invalidCommand(url.pathname);
			console.error(JSON.stringify({ event: 'recipient_signed_failed' }));
			return unavailable(url.pathname);
		}
	};
}

async function resultResponse(
	result: RecipientSignedResult,
	token: string,
	envelopeId: string,
	idempotencyKey: string,
	url: URL,
	platform: Readonly<App.Platform> | undefined,
	cookies: Cookies | null,
	options: RecipientCompletedReceiptHandlerOptions | undefined
): Promise<Response> {
	const instance: string = url.pathname;
	if (result.outcome === 'published' || result.outcome === 'replayed') {
		// Durable terminal sign: seal this envelope's read-only receipt cookie
		// when the durable evidence proves it, then drop only this envelope's
		// live session cookie. A failed exchange costs the recipient the
		// tokenless reload, never the signature, so the response stays a success.
		if (cookies !== null) {
			await exchangeCompletedReceiptCookie({
				token,
				committed: {
					envelopeId,
					recipientId: result.result.recipientId,
					action: 'signed',
					idempotencyKey,
					completedAt: result.result.signedAt
				},
				url,
				platform,
				cookies,
				options
			});
		}
		const headers: Headers = new Headers(securityHeaders({ 'content-type': 'application/json' }));
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(
			JSON.stringify({
				signed: {
					envelopeId: result.result.envelopeId,
					recipientId: result.result.recipientId,
					recipientStatus: 'completed',
					envelopeStatus: result.result.envelopeStatus,
					signedAt: result.result.signedAt
				}
			}),
			{ status: 200, headers }
		);
	}
	if (
		result.outcome === 'not_found' ||
		result.outcome === 'context_mismatch' ||
		result.outcome === 'role_not_actionable'
	) {
		return accessNotFound(instance);
	}
	if (result.outcome === 'idempotency_conflict') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:recipient-signed-idempotency-conflict',
				title: 'Idempotency key conflict',
				status: 409,
				detail: 'The Idempotency-Key was already used for a different recipient signing command.',
				instance
			},
			securityHeaders()
		);
	}
	if (result.outcome === 'field_generation_conflict') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:recipient-signed-field-generation-conflict',
				title: 'Field generation conflict',
				status: 409,
				detail: 'The signing fields changed after this page was loaded.',
				instance
			},
			securityHeaders()
		);
	}
	if (result.outcome === 'invalid_field') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:recipient-signed-invalid-field',
				title: 'Invalid signing field value',
				status: 400,
				detail:
					'A submitted value referenced a field this recipient does not own or did not match its declared type.',
				instance
			},
			securityHeaders()
		);
	}
	if (result.outcome === 'incomplete_field_set') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:recipient-signed-incomplete-field-set',
				title: 'Incomplete signing field set',
				status: 400,
				detail: 'Every field declared for this recipient must receive exactly one value.',
				instance
			},
			securityHeaders()
		);
	}
	if (result.outcome === 'missing_required_value') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:recipient-signed-missing-required-value',
				title: 'Missing required field value',
				status: 400,
				detail: 'A required field was submitted without a value.',
				instance
			},
			securityHeaders()
		);
	}
	if (result.outcome === 'audit_conflict') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:audit-head-conflict',
				title: 'Audit head conflict',
				status: 409,
				detail: 'Another envelope command changed the audit head before signing was recorded.',
				instance
			},
			securityHeaders({ 'retry-after': '1' })
		);
	}
	if (result.outcome === 'delivery_in_flight') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:recipient-signed-delivery-in-flight',
				title: 'Invitation delivery in progress',
				status: 409,
				detail: 'An invitation delivery is currently in progress. Retry signing shortly.',
				instance
			},
			securityHeaders({ 'retry-after': '1' })
		);
	}
	return problemResponse(
		{
			type: 'urn:signkit:problem:recipient-signed-integrity-error',
			title: 'Recipient signing integrity check failed',
			status: 503,
			detail: 'The signing command could not prove a consistent recipient, field, and audit state.',
			instance
		},
		securityHeaders()
	);
}

function accessNotFound(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:recipient-access-not-found',
			title: 'Recipient access not found',
			status: 404,
			detail: 'No active recipient access was found.',
			instance
		},
		securityHeaders()
	);
}

function crossOriginDenied(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:cross-origin-recipient-command',
			title: 'Cross-origin request denied',
			status: 403,
			detail: 'Recipient commands must originate from this SignKit deployment.',
			instance
		},
		securityHeaders()
	);
}

function idempotencyRequired(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:idempotency-key-required',
			title: 'Valid Idempotency-Key required',
			status: 400,
			detail: 'POST requests require one non-empty Idempotency-Key header.',
			instance
		},
		securityHeaders()
	);
}

function unsupportedMediaType(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:unsupported-media-type',
			title: 'Unsupported media type',
			status: 415,
			detail: 'Recipient signing commands require an application/json request body.',
			instance
		},
		securityHeaders()
	);
}

function invalidJson(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:invalid-json',
			title: 'Invalid JSON',
			status: 400,
			detail: 'The request body must be valid JSON.',
			instance
		},
		securityHeaders()
	);
}

function invalidCommand(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:invalid-recipient-signed-command',
			title: 'Invalid recipient signing command',
			status: 400,
			detail:
				'The command must contain a valid envelopeId, recipientId, expectedFieldGeneration, and no more than 50 well-formed field values.',
			instance
		},
		securityHeaders()
	);
}

function bodyTooLarge(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:request-body-too-large',
			title: 'Request body too large',
			status: 413,
			detail: `The request body must not exceed ${MAX_BODY_BYTES} bytes.`,
			instance
		},
		securityHeaders()
	);
}

function unavailable(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:recipient-signed-unavailable',
			title: 'Recipient signing service unavailable',
			status: 503,
			detail: 'The signing command could not be recorded.',
			instance
		},
		securityHeaders()
	);
}

function acceptsJson(request: Request): boolean {
	const contentType: string | null = request.headers.get('content-type');
	return contentType !== null && /^application\/json(?:\s*;|$)/i.test(contentType);
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
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_BODY_BYTES) {
				await reader.cancel();
				return { ok: false, reason: 'too_large' };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false, reason: 'invalid' };
	}

	const bytes: Uint8Array = new Uint8Array(totalBytes);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}

function securityHeaders(additional: Record<string, string> = {}): Record<string, string> {
	return {
		'cache-control': 'no-store',
		'referrer-policy': 'no-referrer',
		vary: 'Cookie, Origin',
		'x-content-type-options': 'nosniff',
		...additional
	};
}
