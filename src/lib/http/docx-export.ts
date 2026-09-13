import type { RequestHandler } from '@sveltejs/kit';
import type { ZodType } from 'zod';
import {
	DraftIntegrityError,
	DraftReadConflictError
} from '$lib/application/drafts/draft-persistence';
import {
	exportEnvelopeDocx,
	type EnvelopeDocxExportResult
} from '$lib/application/documents/docx-export-service';
import { DocxExportError } from '$lib/adapters/documents/docx-export';
import type { EnvelopeDocxExportDependencies } from '$lib/application/documents/docx-export-runtime';
import {
	authorizeScopedOrganizationRequest,
	type AuthorizedApiActor
} from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';

const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type DocxExportResolver = (
	context: ResolverContext
) => EnvelopeDocxExportDependencies | null | Promise<EnvelopeDocxExportDependencies | null>;

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:docx-export-unavailable',
		title: 'DOCX export unavailable',
		status: 503,
		detail: 'The pinned revision could not be exported as DOCX.',
		instance
	});
}

export function createDocxExportHandler(resolveExport: DocxExportResolver): RequestHandler {
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
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'The envelope ID must be a UUID.',
				instance: url.pathname
			});
		}

		let dependencies: EnvelopeDocxExportDependencies | null;
		try {
			dependencies = await resolveExport({ platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'docx_export_resolution_failed',
					message: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailable(url.pathname);
		}
		if (dependencies === null) return unavailable(url.pathname);

		try {
			const result: EnvelopeDocxExportResult = await exportEnvelopeDocx(
				authorized.organizationId,
				envelopeId.data,
				dependencies.envelopes,
				dependencies.objects,
				dependencies.repository
			);
			if (result.outcome === 'not_found') {
				return problemResponse({
					type: 'urn:signkit:problem:envelope-not-found',
					title: 'Envelope not found',
					status: 404,
					detail: 'No envelope was found in the authorized organization.',
					instance: url.pathname
				});
			}
			if (result.outcome === 'empty_draft') {
				return problemResponse({
					type: 'urn:signkit:problem:docx-export-empty',
					title: 'No pinned revision to export',
					status: 409,
					detail: 'The envelope has no pinned Markdown revision to export as DOCX.',
					instance: url.pathname
				});
			}

			const body = new Uint8Array(result.bytes.byteLength);
			body.set(result.bytes);
			return new Response(body, {
				status: 200,
				headers: {
					'content-type': DOCX_CONTENT_TYPE,
					'cache-control': 'no-store',
					'content-disposition': `attachment; filename="envelope-${envelopeId.data}.docx"`,
					'x-content-type-options': 'nosniff',
					'x-signkit-commit-sha': result.commitSha
				}
			});
		} catch (error: unknown) {
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
