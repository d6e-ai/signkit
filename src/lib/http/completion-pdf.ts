import type { RequestHandler } from '@sveltejs/kit';
import type { ZodType } from 'zod';
import {
	completionEvidenceFailureLog,
	type CompletionEvidenceApplicationPort,
	type CompletionPdfResult
} from '$lib/application/completion-artifacts/completion-evidence-service';
import {
	authorizeScopedOrganizationRequest,
	type AuthorizedApiActor
} from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';

const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type CompletionPdfServiceResolver = (
	context: ResolverContext
) => CompletionEvidenceApplicationPort | null | Promise<CompletionEvidenceApplicationPort | null>;

export function createCompletionPdfHandler(
	resolveService: CompletionPdfServiceResolver
): RequestHandler {
	return async ({ locals, params, platform, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedOrganizationRequest(
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

		let service: CompletionEvidenceApplicationPort | null;
		try {
			service = await resolveService({ platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'completion_pdf_resolution_failed',
					...completionEvidenceFailureLog(error)
				})
			);
			service = null;
		}
		if (service === null) return unavailable(url.pathname);

		try {
			const pdf: CompletionPdfResult | null = await service.readPdf(
				authorized.organizationId,
				envelopeId.data
			);
			if (pdf === null) {
				const exists = await service.envelopeExists(authorized.organizationId, envelopeId.data);
				if (!exists) {
					return problemResponse({
						type: 'urn:signkit:problem:envelope-not-found',
						title: 'Envelope not found',
						status: 404,
						detail: 'No envelope was found in the authorized organization.',
						instance: url.pathname
					});
				}
				return problemResponse({
					type: 'urn:signkit:problem:completion-pdf-not-found',
					title: 'Completion PDF not published',
					status: 404,
					detail: 'Completion PDF artifact has not been published for this envelope.',
					instance: url.pathname
				});
			}

			return new Response(pdf.stream, {
				status: 200,
				headers: {
					'content-type': 'application/pdf',
					'cache-control': 'public, max-age=31536000, immutable',
					etag: `"${pdf.sha256}"`,
					'content-disposition': `inline; filename="completion-${envelopeId.data}.pdf"`,
					'x-content-type-options': 'nosniff'
				}
			});
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'completion_pdf_failed',
					...completionEvidenceFailureLog(error)
				})
			);
			return unavailable(url.pathname);
		}
	};
}

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:completion-pdf-unavailable',
		title: 'Completion PDF unavailable',
		status: 503,
		detail: 'Completion PDF could not be read.',
		instance
	});
}
