import type { RequestHandler } from '@sveltejs/kit';
import type { ZodType } from 'zod';
import {
	completionEvidenceFailureLog,
	type CompletionEvidenceApplicationPort,
	type CompletionEvidenceResult
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

export type CompletionEvidenceServiceResolver = (
	context: ResolverContext
) => CompletionEvidenceApplicationPort | null | Promise<CompletionEvidenceApplicationPort | null>;

export function createCompletionEvidenceHandler(
	resolveService: CompletionEvidenceServiceResolver
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
					event: 'completion_evidence_resolution_failed',
					...completionEvidenceFailureLog(error)
				})
			);
			service = null;
		}
		if (service === null) return unavailable(url.pathname);

		const formatParam = url.searchParams.get('format');
		const format: 'json' | 'markdown' = formatParam === 'markdown' ? 'markdown' : 'json';

		try {
			const evidence: CompletionEvidenceResult | null = await service.readEvidence(
				authorized.organizationId,
				envelopeId.data,
				format
			);
			if (evidence === null) {
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
					type: 'urn:signkit:problem:completion-evidence-not-found',
					title: 'Completion evidence not published',
					status: 404,
					detail: 'Completion evidence has not been published for this envelope.',
					instance: url.pathname
				});
			}

			return new Response(evidence.content, {
				status: 200,
				headers: {
					'content-type': evidence.contentType,
					'cache-control': 'private, no-cache',
					etag: `"${evidence.digest}"`,
					'x-content-type-options': 'nosniff'
				}
			});
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'completion_evidence_failed',
					...completionEvidenceFailureLog(error)
				})
			);
			return unavailable(url.pathname);
		}
	};
}

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:completion-evidence-unavailable',
		title: 'Completion evidence unavailable',
		status: 503,
		detail: 'Completion evidence could not be read.',
		instance
	});
}
