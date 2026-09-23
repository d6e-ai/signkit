import type { RequestHandler } from '@sveltejs/kit';
import type {
	PdfSealDownloadApplicationPort,
	PdfSealDownloadResult
} from '$lib/application/pdf-seals/pdf-seal-download';
import { pdfSealDownloadFailureLog } from '$lib/application/pdf-seals/pdf-seal-download';
import { authorizeScopedInstanceRequest, type AuthorizedApiActor } from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type PdfSealDownloadApplicationResolver = (
	context: ResolverContext
) => PdfSealDownloadApplicationPort | null | Promise<PdfSealDownloadApplicationPort | null>;

export function createPdfSealDownloadHandler(
	resolveApplication: PdfSealDownloadApplicationResolver
): RequestHandler {
	return async ({ locals, params, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedInstanceRequest(
			locals,
			url.pathname,
			'envelopes:read'
		);
		if (authorized instanceof Response) return authorized;

		const envelopeId = signkitIdentifierSchema.safeParse(params.envelopeId);
		if (!envelopeId.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-error',
				title: 'Validation failed',
				status: 400,
				detail: 'The envelope ID must be a UUID.',
				instance: url.pathname
			});
		}

		let application: PdfSealDownloadApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch (error: unknown) {
			logFailure('pdf_seal_download_resolution_failed', error);
			return unavailable(url.pathname);
		}
		if (application === null) return unavailable(url.pathname);

		let result: PdfSealDownloadResult;
		try {
			result = await application.read(envelopeId.data);
		} catch (error: unknown) {
			logFailure('pdf_seal_download_failed', error);
			return unavailable(url.pathname);
		}
		if (result.outcome === 'not_found') return envelopeNotFound(url.pathname);
		if (result.outcome === 'not_published') return sealNotPublished(url.pathname);

		const headers: Headers = new Headers({
			'content-type': 'application/pdf',
			'content-length': String(result.pdf.byteSize),
			'cache-control': 'private, no-store, max-age=0, must-revalidate',
			pragma: 'no-cache',
			etag: `"${result.pdf.sha256}"`,
			'content-disposition': 'attachment; filename="sealed-agreement.pdf"',
			'x-content-type-options': 'nosniff',
			'content-security-policy':
				"default-src 'none'; object-src 'none'; script-src 'none'; frame-ancestors 'none'",
			'x-frame-options': 'DENY'
		});
		return new Response(request.method === 'HEAD' ? null : responseBody(result.pdf.bytes), {
			status: 200,
			headers
		});
	};
}

function responseBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(bytes.byteLength));
	copy.set(bytes);
	return copy;
}

function envelopeNotFound(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:envelope-not-found',
		title: 'Envelope not found',
		status: 404,
		detail: 'No envelope was found.',
		instance
	});
}

function sealNotPublished(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:pdf-seal-not-published',
		title: 'PDF seal not published',
		status: 404,
		detail: 'A validated PDF seal has not been published for this envelope.',
		instance
	});
}

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:pdf-seal-pdf-unavailable',
		title: 'Sealed PDF unavailable',
		status: 503,
		detail: 'The validated sealed PDF could not be read.',
		instance
	});
}

function logFailure(event: string, error: unknown): void {
	console.error(JSON.stringify({ event, ...pdfSealDownloadFailureLog(error) }));
}
