import type { Cookies, RequestHandler } from '@sveltejs/kit';
import type { ZodType } from 'zod';
import {
	MAX_SIGNATURE_ASSET_BYTES,
	type SignatureAssetApplicationPort,
	type StoreSignatureAssetResult
} from '$lib/application/documents/signature-asset';
import {
	RECIPIENT_SESSION_COOKIE,
	RECIPIENT_SESSION_COOKIE_PATH
} from '$lib/server/recipient-session';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';

const idSchema: ZodType<string> = signkitIdentifierSchema;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type SignatureAssetApplicationResolver = (
	context: ResolverContext
) => SignatureAssetApplicationPort | null | Promise<SignatureAssetApplicationPort | null>;

export type RecipientSessionUnsealer = (cookie: string) => Promise<string | null>;

export function createSignatureAssetHandler(
	resolveApplication: SignatureAssetApplicationResolver,
	unsealSession: RecipientSessionUnsealer
): RequestHandler {
	return async ({ cookies, platform, request, url }): Promise<Response> => {
		if (request.headers.get('origin') !== url.origin) return crossOriginDenied(url.pathname);

		const envelopeId = idSchema.safeParse(url.searchParams.get('envelopeId'));
		const recipientId = idSchema.safeParse(url.searchParams.get('recipientId'));
		if (!envelopeId.success || !recipientId.success) return invalidCommand(url.pathname);

		if (!isPngContentType(request.headers.get('content-type'))) {
			return unsupportedMediaType(url.pathname);
		}

		const sealed: string | undefined = cookies.get(RECIPIENT_SESSION_COOKIE);
		if (sealed === undefined) return accessNotFound(url.pathname);

		let token: string | null;
		try {
			token = await unsealSession(sealed);
		} catch {
			console.error(JSON.stringify({ event: 'signature_asset_session_failed' }));
			return unavailable(url.pathname);
		}
		if (token === null) return accessNotFound(url.pathname);

		const bytes: Uint8Array | null = await readBoundedBody(request);
		if (bytes === null) return bodyTooLarge(url.pathname);

		let application: SignatureAssetApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch {
			console.error(JSON.stringify({ event: 'signature_asset_resolution_failed' }));
			return unavailable(url.pathname);
		}
		if (application === null) return unavailable(url.pathname);

		try {
			const result: StoreSignatureAssetResult = await application.store({
				token,
				expectedEnvelopeId: envelopeId.data,
				expectedRecipientId: recipientId.data,
				pngBytes: bytes
			});
			return resultResponse(result, url.pathname, cookies);
		} catch {
			console.error(JSON.stringify({ event: 'signature_asset_store_failed' }));
			return unavailable(url.pathname);
		}
	};
}

function resultResponse(
	result: StoreSignatureAssetResult,
	instance: string,
	cookies: Cookies
): Response {
	if (result.outcome === 'stored') {
		return new Response(JSON.stringify({ assetRef: result.assetRef }), {
			status: 201,
			headers: securityHeaders({ 'content-type': 'application/json' })
		});
	}
	if (result.outcome === 'not_found' || result.outcome === 'context_mismatch') {
		return accessNotFound(instance, cookies);
	}
	if (result.outcome === 'too_large') return bodyTooLarge(instance);
	if (result.outcome === 'invalid_image') return invalidCommand(instance);
	return unavailable(instance);
}

function accessNotFound(instance: string, cookies?: Cookies): Response {
	if (cookies) cookies.delete(RECIPIENT_SESSION_COOKIE, { path: RECIPIENT_SESSION_COOKIE_PATH });
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

function unsupportedMediaType(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:unsupported-media-type',
			title: 'Unsupported media type',
			status: 415,
			detail: 'Signature assets must be uploaded as image/png.',
			instance
		},
		securityHeaders()
	);
}

function invalidCommand(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:invalid-signature-asset',
			title: 'Invalid signature asset',
			status: 400,
			detail: 'The request must name a valid envelopeId and recipientId and upload a PNG image.',
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
			detail: `The signature image must not exceed ${MAX_SIGNATURE_ASSET_BYTES} bytes.`,
			instance
		},
		securityHeaders()
	);
}

function unavailable(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:signature-asset-unavailable',
			title: 'Signature asset service unavailable',
			status: 503,
			detail: 'The signature image could not be stored.',
			instance
		},
		securityHeaders()
	);
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
	const contentLength: string | null = request.headers.get('content-length');
	if (contentLength !== null) {
		const declaredBytes: number = Number(contentLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_SIGNATURE_ASSET_BYTES) return null;
	}
	if (request.body === null) return new Uint8Array(0);

	const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes: number = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_SIGNATURE_ASSET_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}
	const bytes: Uint8Array = new Uint8Array(totalBytes);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function isPngContentType(value: string | null): boolean {
	return value !== null && value.split(';', 1)[0].trim().toLowerCase() === 'image/png';
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
