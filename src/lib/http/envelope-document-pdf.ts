import type { RequestHandler } from '@sveltejs/kit';
import type { ZodType } from 'zod';
import type {
	EnvelopeDocumentPdfApplicationPort,
	EnvelopeDocumentPdfResult
} from '$lib/application/documents/envelope-document-pdf';
import { authorizeScopedInstanceRequest, type AuthorizedApiActor } from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';

const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type EnvelopeDocumentPdfResolver = (
	context: ResolverContext
) => EnvelopeDocumentPdfApplicationPort | null | Promise<EnvelopeDocumentPdfApplicationPort | null>;

/**
 * The sender-facing rendering of an envelope's pinned revision.
 *
 * `mode: 'pdf'` streams the bytes for the placement canvas; `mode: 'pages'`
 * returns only the page geometry, which is what the editor needs to know
 * which pages belong to which document before it will let a field be dropped
 * there. Both are instance-scoped through the normal API authority: this
 * is the sender's own document, not a recipient surface.
 */
export function createEnvelopeDocumentPdfHandler(
	resolveApplication: EnvelopeDocumentPdfResolver,
	mode: 'pdf' | 'pages'
): RequestHandler {
	return async ({ locals, params, platform, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedInstanceRequest(
			locals,
			url.pathname,
			'envelopes:read'
		);
		if (authorized instanceof Response) return authorized;

		const envelopeId = envelopeIdSchema.safeParse(params.envelopeId);
		if (!envelopeId.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-error',
				title: 'Validation failed',
				status: 400,
				detail: 'The envelope ID must be a UUID.',
				instance: url.pathname
			});
		}
		const documentId = envelopeIdSchema.safeParse(url.searchParams.get('documentId'));
		if (!documentId.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-error',
				title: 'Validation failed',
				status: 400,
				detail: 'A documentId query parameter is required.',
				instance: url.pathname
			});
		}

		let application: EnvelopeDocumentPdfApplicationPort | null;
		try {
			application = await resolveApplication({ locals, platform });
		} catch {
			console.error(JSON.stringify({ event: 'envelope_document_pdf_resolution_failed' }));
			application = null;
		}
		if (application === null) return unavailable(url.pathname);

		let result: EnvelopeDocumentPdfResult;
		try {
			result = await application.read(envelopeId.data, documentId.data);
		} catch {
			console.error(JSON.stringify({ event: 'envelope_document_pdf_failed' }));
			return unavailable(url.pathname);
		}

		if (result.outcome === 'not_found') {
			return problemResponse({
				type: 'urn:signkit:problem:envelope-not-found',
				title: 'Envelope not found',
				status: 404,
				detail: 'No envelope was found.',
				instance: url.pathname
			});
		}
		if (result.outcome === 'no_documents') {
			return problemResponse({
				type: 'urn:signkit:problem:envelope-document-pdf-unavailable',
				title: 'Envelope has no renderable documents',
				status: 409,
				detail: 'The envelope has no committed documents to render.',
				instance: url.pathname
			});
		}
		if (result.outcome === 'unavailable') return unavailable(url.pathname);

		if (mode === 'pages') {
			return new Response(
				JSON.stringify({
					commitSha: result.pdf.commitSha,
					generation: result.pdf.generation,
					documentId: result.pdf.documentId,
					pageCount: result.pdf.pageCount,
					pageWidth: result.pdf.pageWidth,
					pageHeight: result.pdf.pageHeight,
					documents: result.pdf.documents
				}),
				{
					status: 200,
					headers: {
						'content-type': 'application/json',
						'cache-control': 'private, no-store',
						'x-content-type-options': 'nosniff'
					}
				}
			);
		}

		const body: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(result.pdf.byteSize));
		body.set(result.pdf.bytes);
		return new Response(body, {
			status: 200,
			headers: {
				'content-type': 'application/pdf',
				'cache-control': 'private, no-store',
				etag: `"${result.pdf.sha256}"`,
				'content-disposition': 'attachment; filename="envelope-documents.pdf"',
				// Nothing frames this response. The placement editor fetches the
				// bytes and draws them to a canvas itself, so no origin -- including
				// this one -- needs framing permission, and refusing it outright
				// removes clickjacking as a way to put this document in front of
				// someone.
				'content-security-policy':
					"default-src 'none'; object-src 'none'; script-src 'none'; frame-ancestors 'none'",
				'x-content-type-options': 'nosniff',
				'x-frame-options': 'DENY'
			}
		});
	};
}

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:envelope-document-pdf-unavailable',
		title: 'Envelope document PDF unavailable',
		status: 503,
		detail: 'The envelope document rendering could not be produced.',
		instance
	});
}
