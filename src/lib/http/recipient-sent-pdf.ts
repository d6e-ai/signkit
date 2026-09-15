import type { RequestHandler } from '@sveltejs/kit';
import type {
	RecipientSentPdfApplicationPort,
	RecipientSentPdfResult
} from '$lib/application/signing/recipient-sent-pdf';
import { isUuidV7 } from '$lib/ids/uuid-v7';
import { readRecipientSessionCookie } from '$lib/server/recipient-session';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type RecipientSentPdfApplicationResolver = (
	context: ResolverContext
) => RecipientSentPdfApplicationPort | null | Promise<RecipientSentPdfApplicationPort | null>;

export type RecipientSessionUnsealer = (
	cookie: string,
	envelopeId: string
) => Promise<string | null>;

/**
 * Serves the sent agreement PDF to the browser that already holds an active
 * recipient session for the envelope named in the path.
 *
 * Authority comes only from the sealed, http-only session cookie bound to
 * that envelope ID. No token appears in the URL, in page data, or anywhere
 * JavaScript can read it, so the address of this document is not a bearer
 * credential and cannot leak through history, referrers, logs, or a shared
 * link. A path/cookie mismatch, a missing session, or a non-UUIDv7 path
 * segment fails closed as an opaque 404.
 *
 * The response is deliberately uninformative on failure: an inactive,
 * expired, revoked, or absent session is indistinguishable from a path that
 * was never valid (an empty 404), and every storage or integrity problem
 * collapses to the same fixed 503. Neither body carries an identifier, a
 * name, an object key, or a provider message.
 */
export function createRecipientSentPdfHandler(
	resolveApplication: RecipientSentPdfApplicationResolver,
	unsealSession: RecipientSessionUnsealer
): RequestHandler {
	return async ({ cookies, params, platform, request }): Promise<Response> => {
		if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();

		const envelopeId: string | undefined = params.envelopeId;
		if (envelopeId === undefined || !isUuidV7(envelopeId)) return notFound();
		const documentId: string | undefined = params.documentId;
		if (documentId !== undefined && !isUuidV7(documentId)) return notFound();

		const sealed: string | undefined = readRecipientSessionCookie(cookies, envelopeId);
		if (sealed === undefined) return notFound();

		let token: string | null;
		try {
			token = await unsealSession(sealed, envelopeId);
		} catch {
			console.error(JSON.stringify({ event: 'recipient_sent_pdf_session_failed' }));
			return unavailable();
		}
		if (token === null) return notFound();

		let application: RecipientSentPdfApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch {
			console.error(JSON.stringify({ event: 'recipient_sent_pdf_resolution_failed' }));
			return unavailable();
		}
		if (application === null) return unavailable();

		let result: RecipientSentPdfResult;
		try {
			result = await application.read(token, envelopeId, documentId);
		} catch {
			console.error(JSON.stringify({ event: 'recipient_sent_pdf_read_failed' }));
			return unavailable();
		}
		if (result.outcome === 'not_found') return notFound();
		if (result.outcome === 'unavailable') return unavailable();

		const headers: Headers = securityHeaders();
		headers.set('content-type', 'application/pdf');
		headers.set('content-length', String(result.byteSize));
		// A generic filename: the envelope title and the recipient's name are
		// exactly the kind of thing a download folder, a proxy log, or a
		// screenshot would carry further than the session that earned it.
		headers.set('content-disposition', 'attachment; filename="agreement.pdf"');
		headers.set('etag', `"${result.sha256}"`);
		return new Response(request.method === 'HEAD' ? null : bodyOf(result.bytes), {
			status: 200,
			headers
		});
	};
}

function bodyOf(bytes: Uint8Array): BodyInit {
	const copy: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(bytes.byteLength));
	copy.set(bytes);
	return copy;
}

function securityHeaders(): Headers {
	return new Headers({
		// Private and uncacheable: a shared cache must never be able to hand
		// this document to the next person through the same proxy.
		'cache-control': 'private, no-store, max-age=0, must-revalidate',
		pragma: 'no-cache',
		'referrer-policy': 'no-referrer',
		vary: 'Cookie',
		'x-content-type-options': 'nosniff',
		// Nothing frames this response. The signing page fetches the bytes and
		// draws them to a canvas itself, so no origin -- including this one --
		// needs framing permission, and refusing it outright removes
		// clickjacking as a way to get an agreement in front of someone.
		'content-security-policy':
			"default-src 'none'; object-src 'none'; script-src 'none'; frame-ancestors 'none'",
		'x-frame-options': 'DENY'
	});
}

function notFound(): Response {
	return new Response(null, { status: 404, headers: securityHeaders() });
}

function unavailable(): Response {
	return new Response(null, { status: 503, headers: securityHeaders() });
}
