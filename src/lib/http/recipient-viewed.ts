import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodType } from 'zod';
import type {
	RecipientViewedApplicationPort,
	RecipientViewedResult
} from '$lib/application/signing/recipient-viewed';
import { readRecipientSessionCookie } from '$lib/server/recipient-session';
import { boundEnvelopeId } from './envelope-binding';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';
import { recipientBearerToken, type RecipientHttpMode } from './recipient-bearer';

const MAX_BODY_BYTES: number = 4 * 1024;
const idSchema: ZodType<string> = signkitIdentifierSchema;
const bodySchema = z
	.object({
		envelopeId: idSchema,
		recipientId: idSchema
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

export type RecipientViewedApplicationResolver = (
	context: ResolverContext
) => RecipientViewedApplicationPort | null | Promise<RecipientViewedApplicationPort | null>;

export type RecipientSessionUnsealer = (
	cookie: string,
	envelopeId: string
) => Promise<string | null>;

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

export function createRecipientViewedHandler(
	resolveApplication: RecipientViewedApplicationResolver,
	unsealSession: RecipientSessionUnsealer,
	mode: RecipientHttpMode = 'browser'
): RequestHandler {
	return async ({ cookies, platform, request, url }): Promise<Response> => {
		if (mode === 'browser' && request.headers.get('origin') !== url.origin)
			return crossOriginDenied(url.pathname);

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
			token = recipientBearerToken(request);
		} else {
			const sealed: string | undefined = readRecipientSessionCookie(cookies, envelopeId);
			if (sealed === undefined) return accessNotFound(url.pathname);
			try {
				token = await unsealSession(sealed, envelopeId);
			} catch {
				console.error(JSON.stringify({ event: 'recipient_viewed_session_failed' }));
				return unavailable(url.pathname);
			}
		}
		if (token === null) {
			return accessNotFound(url.pathname);
		}

		let application: RecipientViewedApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch {
			console.error(JSON.stringify({ event: 'recipient_viewed_resolution_failed' }));
			return unavailable(url.pathname);
		}
		if (application === null) return unavailable(url.pathname);

		try {
			const result: RecipientViewedResult = await application.view({
				token,
				expectedEnvelopeId: envelopeId,
				expectedRecipientId: parsed.data.recipientId,
				idempotencyKey: idempotencyKey.data
			});
			return resultResponse(result, url.pathname);
		} catch {
			console.error(JSON.stringify({ event: 'recipient_viewed_failed' }));
			return unavailable(url.pathname);
		}
	};
}

function resultResponse(result: RecipientViewedResult, instance: string): Response {
	if (
		result.outcome === 'published' ||
		result.outcome === 'replayed' ||
		result.outcome === 'continued'
	) {
		const headers: Headers = new Headers(securityHeaders({ 'content-type': 'application/json' }));
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(
			JSON.stringify({
				viewed: {
					envelopeId: result.result.envelopeId,
					recipientId: result.result.recipientId,
					recipientStatus: 'viewed',
					envelopeStatus: result.result.envelopeStatus,
					viewedAt: result.result.viewedAt,
					...(result.outcome === 'continued' ? { continuation: true } : {})
				}
			}),
			{ status: 200, headers }
		);
	}
	if (result.outcome === 'not_found' || result.outcome === 'context_mismatch') {
		return accessNotFound(instance);
	}
	if (result.outcome === 'idempotency_conflict') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:recipient-viewed-idempotency-conflict',
				title: 'Idempotency key conflict',
				status: 409,
				detail: 'The Idempotency-Key was already used for a different recipient view command.',
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
				detail: 'Another envelope command changed the audit head before the view was recorded.',
				instance
			},
			securityHeaders({ 'retry-after': '1' })
		);
	}
	return problemResponse(
		{
			type: 'urn:signkit:problem:recipient-viewed-integrity-error',
			title: 'Recipient view integrity check failed',
			status: 503,
			detail: 'The view command could not prove a consistent recipient and audit state.',
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
			detail: 'Recipient view commands require an application/json request body.',
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
			type: 'urn:signkit:problem:invalid-recipient-view-command',
			title: 'Invalid recipient view command',
			status: 400,
			detail: 'The command must contain only valid envelopeId and recipientId values.',
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
			type: 'urn:signkit:problem:recipient-viewed-unavailable',
			title: 'Recipient view service unavailable',
			status: 503,
			detail: 'The recipient view could not be recorded.',
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
