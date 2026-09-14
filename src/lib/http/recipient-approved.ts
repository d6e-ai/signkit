import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { z, type ZodType } from 'zod';
import type {
	RecipientApprovedApplicationPort,
	RecipientApprovedResult
} from '$lib/application/signing/recipient-approved';
import {
	deleteRecipientSessionCookie,
	readRecipientSessionCookie
} from '$lib/server/recipient-session';
import { boundEnvelopeId } from './envelope-binding';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';

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

export type RecipientApprovedApplicationResolver = (
	context: ResolverContext
) => RecipientApprovedApplicationPort | null | Promise<RecipientApprovedApplicationPort | null>;

export type RecipientSessionUnsealer = (
	cookie: string,
	envelopeId: string
) => Promise<string | null>;

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

export function createRecipientApprovedHandler(
	resolveApplication: RecipientApprovedApplicationResolver,
	unsealSession: RecipientSessionUnsealer
): RequestHandler {
	return async ({ cookies, platform, request, url }): Promise<Response> => {
		if (request.headers.get('origin') !== url.origin) return crossOriginDenied(url.pathname);

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

		const sealed: string | undefined = readRecipientSessionCookie(cookies, envelopeId);
		if (sealed === undefined) return accessNotFound(url.pathname);

		let token: string | null;
		try {
			token = await unsealSession(sealed, envelopeId);
		} catch {
			console.error(JSON.stringify({ event: 'recipient_approved_session_failed' }));
			return unavailable(url.pathname);
		}
		if (token === null) return accessNotFound(url.pathname);

		let application: RecipientApprovedApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch {
			console.error(JSON.stringify({ event: 'recipient_approved_resolution_failed' }));
			return unavailable(url.pathname);
		}
		if (application === null) return unavailable(url.pathname);

		try {
			const result: RecipientApprovedResult = await application.approve({
				token,
				expectedEnvelopeId: envelopeId,
				expectedRecipientId: parsed.data.recipientId,
				idempotencyKey: idempotencyKey.data
			});
			return resultResponse(result, url.pathname, cookies, envelopeId);
		} catch {
			console.error(JSON.stringify({ event: 'recipient_approved_failed' }));
			return unavailable(url.pathname);
		}
	};
}

function resultResponse(
	result: RecipientApprovedResult,
	instance: string,
	cookies: Cookies,
	envelopeId: string
): Response {
	if (result.outcome === 'published' || result.outcome === 'replayed') {
		clearSession(cookies, envelopeId);
		const headers: Headers = new Headers(securityHeaders({ 'content-type': 'application/json' }));
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(
			JSON.stringify({
				approved: {
					envelopeId: result.result.envelopeId,
					recipientId: result.result.recipientId,
					recipientStatus: 'completed',
					envelopeStatus: result.result.envelopeStatus,
					approvedAt: result.result.approvedAt
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
				type: 'urn:signkit:problem:recipient-approved-idempotency-conflict',
				title: 'Idempotency key conflict',
				status: 409,
				detail: 'The Idempotency-Key was already used for a different recipient approval command.',
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
				detail: 'Another envelope command changed the audit head before the approval was recorded.',
				instance
			},
			securityHeaders({ 'retry-after': '1' })
		);
	}
	if (result.outcome === 'delivery_in_flight') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:recipient-approved-delivery-in-flight',
				title: 'Invitation delivery in progress',
				status: 409,
				detail: 'An invitation delivery is currently in progress. Retry the approval shortly.',
				instance
			},
			securityHeaders({ 'retry-after': '1' })
		);
	}
	return problemResponse(
		{
			type: 'urn:signkit:problem:recipient-approved-integrity-error',
			title: 'Recipient approval integrity check failed',
			status: 503,
			detail: 'The approval command could not prove a consistent recipient and audit state.',
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
			detail: 'Recipient approval commands require an application/json request body.',
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
			type: 'urn:signkit:problem:invalid-recipient-approved-command',
			title: 'Invalid recipient approval command',
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
			type: 'urn:signkit:problem:recipient-approved-unavailable',
			title: 'Recipient approval service unavailable',
			status: 503,
			detail: 'The recipient approval could not be recorded.',
			instance
		},
		securityHeaders()
	);
}

function clearSession(cookies: Cookies, envelopeId: string): void {
	deleteRecipientSessionCookie(cookies, envelopeId);
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
