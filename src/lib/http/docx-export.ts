import type { RequestHandler } from '@sveltejs/kit';
import type { ZodType } from 'zod';
import {
	DraftIntegrityError,
	DraftReadConflictError,
	DraftEnvelopeNotFoundError
} from '$lib/application/drafts/draft-persistence';
import {
	DocxConversionService,
	type DocxConversionItemOutcome
} from '$lib/application/documents/docx-conversion-service';
import { DocxExportError } from '$lib/adapters/documents/docx-export';
import type { EnqueueDocxConversionResult } from '$lib/ports/docx-conversion-store';
import { authorizeScopedInstanceRequest, type AuthorizedApiActor } from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';

const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type DocxExportResolver = (
	context: ResolverContext
) =>
	| Pick<DocxConversionService, 'enqueueExport' | 'processInline' | 'readExportResult'>
	| null
	| Promise<Pick<
			DocxConversionService,
			'enqueueExport' | 'processInline' | 'readExportResult'
	  > | null>;

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:docx-export-unavailable',
		title: 'DOCX export unavailable',
		status: 503,
		detail: 'The pinned revision could not be exported as DOCX.',
		instance
	});
}

function conversionOutcomeProblem(
	outcome: Exclude<DocxConversionItemOutcome, { outcome: 'succeeded' }>,
	instance: string
): Response {
	if (outcome.outcome === 'stale' || outcome.outcome === 'retryable_failed') {
		const response: Response = unavailable(instance);
		response.headers.set('retry-after', '30');
		return response;
	}
	if (outcome.outcome === 'permanently_failed' && outcome.errorCode === 'empty_draft') {
		return problemResponse({
			type: 'urn:signkit:problem:docx-export-empty',
			title: 'No pinned revision to export',
			status: 409,
			detail: 'The pinned revision cannot be exported as DOCX.',
			instance
		});
	}
	return unavailable(instance);
}

export function createDocxExportHandler(resolveExport: DocxExportResolver): RequestHandler {
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
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'The envelope ID must be a UUID.',
				instance: url.pathname
			});
		}

		let service: Pick<
			DocxConversionService,
			'enqueueExport' | 'processInline' | 'readExportResult'
		> | null;
		try {
			service = await resolveExport({ platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'docx_export_resolution_failed',
					message: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailable(url.pathname);
		}
		if (service === null) return unavailable(url.pathname);

		try {
			const enqueued: EnqueueDocxConversionResult = await service.enqueueExport({
				envelopeId: envelopeId.data
			});
			if (enqueued.outcome === 'conflict') return unavailable(url.pathname);
			const processed: DocxConversionItemOutcome = await service.processInline(enqueued.job.id);
			if (processed.outcome !== 'succeeded') {
				return conversionOutcomeProblem(processed, url.pathname);
			}
			if (processed.job.direction !== 'export') return unavailable(url.pathname);
			const exported: Uint8Array = await service.readExportResult(processed.job);
			const body = new Uint8Array(exported.byteLength);
			body.set(exported);
			return new Response(body, {
				status: 200,
				headers: {
					'content-type': DOCX_CONTENT_TYPE,
					'cache-control': 'no-store',
					'content-disposition': `attachment; filename="envelope-${envelopeId.data}.docx"`,
					'x-content-type-options': 'nosniff',
					'x-signkit-commit-sha': processed.job.sourceCommitSha
				}
			});
		} catch (error: unknown) {
			if (error instanceof DraftEnvelopeNotFoundError) {
				return problemResponse({
					type: 'urn:signkit:problem:envelope-not-found',
					title: 'Envelope not found',
					status: 404,
					detail: 'No envelope was found.',
					instance: url.pathname
				});
			}
			if (error instanceof DocxExportError) {
				return problemResponse({
					type: 'urn:signkit:problem:docx-export-empty',
					title: 'No pinned revision to export',
					status: 409,
					detail: error.message,
					instance: url.pathname
				});
			}
			console.error(
				JSON.stringify({
					event:
						error instanceof DraftIntegrityError
							? 'docx_export_integrity_check_failed'
							: error instanceof DraftReadConflictError
								? 'docx_export_read_conflict'
								: 'docx_export_failed',
					message: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailable(url.pathname);
		}
	};
}
