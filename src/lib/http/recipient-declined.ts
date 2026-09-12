import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { z, type ZodType } from 'zod';
import type {
	RecipientDeclinedApplicationPort,
	RecipientDeclinedResult
} from '$lib/application/signing/recipient-declined';
import type {
	AuthorizedRecipientDeclinedReceipt,
	RecipientDeclinedReceiptApplicationPort
} from '$lib/application/signing/recipient-declined-receipt';
import {
	DECLINED_RECEIPT_COOKIE,
	DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS,
	DECLINED_RECEIPT_COOKIE_OPTIONS,
	type DeclinedReceiptSessionLocator,
	sealDeclinedReceiptSession
} from '$lib/server/declined-receipt-session';
import {
	RECIPIENT_SESSION_COOKIE,
	RECIPIENT_SESSION_COOKIE_PATH
} from '$lib/server/recipient-session';
import { problemResponse } from './problem';

const MAX_BODY_BYTES: number = 4 * 1024;
const idSchema: ZodType<string> = z.string().uuid();
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

export type RecipientDeclinedApplicationResolver = (
	context: ResolverContext
) => RecipientDeclinedApplicationPort | null | Promise<RecipientDeclinedApplicationPort | null>;

export type RecipientSessionUnsealer = (cookie: string) => Promise<string | null>;

export type RecipientDeclinedReceiptApplicationResolver = (
	context: ResolverContext
) =>
	| RecipientDeclinedReceiptApplicationPort
	| null
	| Promise<RecipientDeclinedReceiptApplicationPort | null>;

export type DeclinedReceiptSessionSealer = (
	locator: DeclinedReceiptSessionLocator
) => Promise<string>;

export interface RecipientDeclinedHandlerOptions {
	resolveReceiptApplication: RecipientDeclinedReceiptApplicationResolver;
	sealReceiptSession?: DeclinedReceiptSessionSealer;
	now?: () => Date;
	allowInsecureLocalDevelopment?: boolean;
}

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

export function createRecipientDeclinedHandler(
	resolveApplication: RecipientDeclinedApplicationResolver,
	unsealSession: RecipientSessionUnsealer,
	options?: RecipientDeclinedHandlerOptions
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

		const sealed: string | undefined = cookies.get(RECIPIENT_SESSION_COOKIE);
		if (sealed === undefined) return accessNotFound(url.pathname);

		let token: string | null;
		try {
			token = await unsealSession(sealed);
		} catch {
			console.error(JSON.stringify({ event: 'recipient_declined_session_failed' }));
			return unavailable(url.pathname);
		}
		if (token === null) {
			clearSession(cookies);
			return accessNotFound(url.pathname);
		}

		let application: RecipientDeclinedApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch {
			console.error(JSON.stringify({ event: 'recipient_declined_resolution_failed' }));
			return unavailable(url.pathname);
		}
		if (application === null) return unavailable(url.pathname);

		try {
			const result: RecipientDeclinedResult = await application.decline({
				token,
				expectedEnvelopeId: parsed.data.envelopeId,
				expectedRecipientId: parsed.data.recipientId,
				idempotencyKey: idempotencyKey.data
			});
			return await resultResponse(result, token, url, platform, cookies, options);
		} catch {
			console.error(JSON.stringify({ event: 'recipient_declined_failed' }));
			return unavailable(url.pathname);
		}
	};
}

async function resultResponse(
	result: RecipientDeclinedResult,
	token: string,
	url: URL,
	platform: Readonly<App.Platform> | undefined,
	cookies: Cookies,
	options: RecipientDeclinedHandlerOptions | undefined
): Promise<Response> {
	const instance: string = url.pathname;
	if (result.outcome === 'published' || result.outcome === 'replayed') {
		const exchanged: boolean = await exchangeDeclinedReceipt(
			result,
			token,
			url,
			platform,
			cookies,
			options
		);
		if (!exchanged) return unavailable(instance);
		const headers: Headers = new Headers(securityHeaders({ 'content-type': 'application/json' }));
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(
			JSON.stringify({
				declined: {
					envelopeId: result.result.envelopeId,
					recipientId: result.result.recipientId,
					recipientStatus: 'declined',
					envelopeStatus: result.result.envelopeStatus,
					declinedAt: result.result.declinedAt
				}
			}),
			{ status: 200, headers }
		);
	}
	if (result.outcome === 'not_found') {
		clearSession(cookies);
		return accessNotFound(instance);
	}
	if (result.outcome === 'context_mismatch' || result.outcome === 'role_not_actionable') {
		return accessNotFound(instance);
	}
	if (result.outcome === 'idempotency_conflict') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:recipient-declined-idempotency-conflict',
				title: 'Idempotency key conflict',
				status: 409,
				detail: 'The Idempotency-Key was already used for a different recipient decline command.',
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
				detail: 'Another envelope command changed the audit head before the decline was recorded.',
				instance
			},
			securityHeaders({ 'retry-after': '1' })
		);
	}
	if (result.outcome === 'delivery_in_flight') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:recipient-declined-delivery-in-flight',
				title: 'Invitation delivery in progress',
				status: 409,
				detail:
					'An invitation delivery is currently in progress. Retry the decline command shortly.',
				instance
			},
			securityHeaders({ 'retry-after': '1' })
		);
	}
	return problemResponse(
		{
			type: 'urn:signkit:problem:recipient-declined-integrity-error',
			title: 'Recipient decline integrity check failed',
			status: 503,
			detail: 'The decline command could not prove a consistent recipient and audit state.',
			instance
		},
		securityHeaders()
	);
}

async function exchangeDeclinedReceipt(
	result: Extract<RecipientDeclinedResult, { outcome: 'published' | 'replayed' }>,
	token: string,
	url: URL,
	platform: Readonly<App.Platform> | undefined,
	cookies: Cookies,
	options: RecipientDeclinedHandlerOptions | undefined
): Promise<boolean> {
	if (options === undefined) return false;
	try {
		const application: RecipientDeclinedReceiptApplicationPort | null =
			await options.resolveReceiptApplication({ platform });
		if (application === null) return false;
		const now: Date = options.now?.() ?? new Date();
		const authorized: AuthorizedRecipientDeclinedReceipt | null = await application.recoverByToken(
			token,
			now
		);
		if (authorized === null || !samePublishedReceipt(result, authorized)) return false;
		const remainingSeconds: number = remainingReceiptSeconds(authorized.locator.expiresAt, now);
		if (remainingSeconds <= 0) return false;
		const locator: DeclinedReceiptSessionLocator = {
			...authorized.locator,
			version: 1
		};
		const seal: DeclinedReceiptSessionSealer =
			options.sealReceiptSession ?? sealDeclinedReceiptSession;
		const sealed: string = await seal(locator);
		cookies.set(DECLINED_RECEIPT_COOKIE, sealed, {
			...DECLINED_RECEIPT_COOKIE_OPTIONS,
			secure: !isInsecureLocalDevelopment(url, options.allowInsecureLocalDevelopment ?? dev),
			maxAge: remainingSeconds
		});
		clearSession(cookies);
		return true;
	} catch {
		console.error(JSON.stringify({ event: 'recipient_declined_receipt_exchange_failed' }));
		return false;
	}
}

function samePublishedReceipt(
	result: Extract<RecipientDeclinedResult, { outcome: 'published' | 'replayed' }>,
	authorized: AuthorizedRecipientDeclinedReceipt
): boolean {
	return (
		authorized.receipt.envelopeId === result.result.envelopeId &&
		authorized.receipt.recipientId === result.result.recipientId &&
		authorized.receipt.declinedAt === result.result.declinedAt
	);
}

function remainingReceiptSeconds(expiresAt: string, now: Date): number {
	const remainingSeconds: number = Math.floor((Date.parse(expiresAt) - now.valueOf()) / 1000);
	if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return 0;
	return Math.min(remainingSeconds, DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS);
}

function isInsecureLocalDevelopment(url: URL, allowed: boolean): boolean {
	if (!allowed || url.protocol !== 'http:') return false;
	return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
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
			detail: 'Recipient decline commands require an application/json request body.',
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
			type: 'urn:signkit:problem:invalid-recipient-declined-command',
			title: 'Invalid recipient decline command',
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
			type: 'urn:signkit:problem:recipient-declined-unavailable',
			title: 'Recipient decline service unavailable',
			status: 503,
			detail: 'The recipient decline could not be recorded.',
			instance
		},
		securityHeaders()
	);
}

function clearSession(cookies: Cookies): void {
	cookies.delete(RECIPIENT_SESSION_COOKIE, { path: RECIPIENT_SESSION_COOKIE_PATH });
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
