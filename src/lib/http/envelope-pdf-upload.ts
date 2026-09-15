import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import {
	DraftDocumentSetError,
	DraftEnvelopeImmutableError,
	DraftEnvelopeNotFoundError,
	DraftGenerationConflictError,
	DraftIdempotencyConflictError,
	DraftIntegrityError,
	type CommitDraftResult
} from '$lib/application/drafts/draft-persistence';
import { MAX_DRAFT_GENERATION } from '$lib/domain/draft';
import { MAX_UPLOADED_PDF_BYTES } from '$lib/application/documents/uploaded-pdf';
import {
	UploadedPdfUploadError,
	UploadedPdfUploadService
} from '$lib/application/documents/uploaded-pdf-upload-service';
import type { UploadedPdfUploadDependencies } from '$lib/application/documents/uploaded-pdf-runtime';
import {
	authorizeScopedOrganizationRequest,
	type AuthorizedApiActor
} from './api-key-authorization';
import { readBoundedBytes } from './docx-import';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse, type ProblemValidationError } from './problem';

const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7e]+$/, 'Idempotency-Key must contain visible ASCII characters only');
const expectedGenerationSchema: ZodType<number> = z.coerce
	.number()
	.int()
	.min(0)
	.max(MAX_DRAFT_GENERATION - 1);
const titleSchema: ZodType<string> = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.refine((value: string): boolean => !hasControlCharacter(value), {
		message: 'Title must not contain control characters'
	});
const positionSchema: ZodType<number> = z.coerce.number().int().min(0).max(19);

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type PdfUploadDependenciesResolver = (
	context: ResolverContext
) => UploadedPdfUploadDependencies | null | Promise<UploadedPdfUploadDependencies | null>;

type ParsedUpload =
	| {
			ok: true;
			expectedGeneration: number;
			pdfBytes: Uint8Array;
			title?: string;
			position?: number;
	  }
	| { ok: false; response: Response };

function validationErrors(issues: readonly ZodIssue[]): readonly ProblemValidationError[] {
	return issues.map((issue: ZodIssue): ProblemValidationError => ({
		path: issue.path.length === 0 ? '$' : issue.path.join('.'),
		message: issue.message
	}));
}

function unavailableProblem(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:draft-service-unavailable',
		title: 'Draft service unavailable',
		status: 503,
		detail: 'The PDF upload could not be committed safely.',
		instance
	});
}

function notFoundProblem(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:envelope-not-found',
		title: 'Envelope not found',
		status: 404,
		detail: 'No envelope was found in the authorized organization.',
		instance
	});
}

function mediaType(request: Request): string {
	return request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
}

async function parseUpload(request: Request, url: URL): Promise<ParsedUpload> {
	const type: string = mediaType(request);
	if (type === 'application/pdf' || type === 'application/octet-stream') {
		const generationResult = expectedGenerationSchema.safeParse(
			url.searchParams.get('expectedGeneration')
		);
		const titleParam: string | null = url.searchParams.get('title');
		const titleResult =
			titleParam === null || titleParam === ''
				? { success: true as const, data: undefined }
				: titleSchema.safeParse(titleParam);
		const positionParam: string | null = url.searchParams.get('position');
		const positionResult =
			positionParam === null || positionParam === ''
				? { success: true as const, data: undefined }
				: positionSchema.safeParse(positionParam);
		if (!generationResult.success || !titleResult.success || !positionResult.success) {
			return {
				ok: false,
				response: problemResponse({
					type: 'urn:signkit:problem:validation-failed',
					title: 'Request validation failed',
					status: 400,
					detail: 'The PDF upload request did not match the required schema.',
					instance: url.pathname,
					errors: validationErrors([
						...(generationResult.success ? [] : generationResult.error.issues),
						...(!titleResult.success ? titleResult.error.issues : []),
						...(!positionResult.success ? positionResult.error.issues : [])
					])
				})
			};
		}
		const bodyResult = await readBoundedBytes(request, MAX_UPLOADED_PDF_BYTES);
		if (!bodyResult.ok && bodyResult.reason === 'too_large') {
			return { ok: false, response: tooLarge(url.pathname) };
		}
		if (!bodyResult.ok) {
			return {
				ok: false,
				response: problemResponse({
					type: 'urn:signkit:problem:validation-failed',
					title: 'Request validation failed',
					status: 400,
					detail: 'PDF upload requires a non-empty PDF body.',
					instance: url.pathname,
					errors: [{ path: '$', message: 'A PDF body is required' }]
				})
			};
		}
		return {
			ok: true,
			expectedGeneration: generationResult.data,
			pdfBytes: bodyResult.bytes,
			title: titleResult.data,
			position: positionResult.data
		};
	}

	return {
		ok: false,
		response: problemResponse({
			type: 'urn:signkit:problem:unsupported-media-type',
			title: 'Unsupported media type',
			status: 415,
			detail:
				'PDF upload accepts a raw application/pdf (or application/octet-stream) body; multipart/form-data is not supported.',
			instance: url.pathname
		})
	};
}

function tooLarge(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:request-body-too-large',
		title: 'Request body too large',
		status: 413,
		detail: `The uploaded PDF file must not exceed ${MAX_UPLOADED_PDF_BYTES} bytes.`,
		instance
	});
}

function draftActor(authorized: AuthorizedApiActor): {
	id: string;
	name: string;
	email: string;
	type: 'user' | 'agent';
} {
	if (authorized.authority === 'api_key') {
		return {
			id: authorized.id,
			name: 'SignKit agent',
			email: `agent+${authorized.id}@users.noreply.signkit.invalid`,
			type: 'agent'
		};
	}
	return {
		id: authorized.id,
		name: authorized.name ?? 'SignKit operator',
		email: authorized.email ?? `user+${authorized.id}@users.noreply.signkit.invalid`,
		type: 'user'
	};
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code: number = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

export function createPdfUploadHandler(
	resolveDependencies: PdfUploadDependenciesResolver
): RequestHandler {
	return async ({ locals, params, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedOrganizationRequest(
			locals,
			url.pathname,
			'drafts:write'
		);
		if (authorized instanceof Response) return authorized;

		const envelopeIdResult = envelopeIdSchema.safeParse(params.envelopeId);
		if (!envelopeIdResult.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'The envelope ID must be a UUID.',
				instance: url.pathname,
				errors: validationErrors(envelopeIdResult.error.issues)
			});
		}

		const idempotencyResult = idempotencyKeySchema.safeParse(
			request.headers.get('idempotency-key')
		);
		if (!idempotencyResult.success) {
			return problemResponse({
				type: 'urn:signkit:problem:idempotency-key-required',
				title: 'Valid Idempotency-Key required',
				status: 400,
				detail: 'POST requests require one non-empty Idempotency-Key header.',
				instance: url.pathname,
				errors: validationErrors(idempotencyResult.error.issues)
			});
		}

		const parsed: ParsedUpload = await parseUpload(request, url);
		if (!parsed.ok) return parsed.response;

		let dependencies: UploadedPdfUploadDependencies | null;
		try {
			dependencies = await resolveDependencies({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'pdf_upload_resolution_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
		if (dependencies === null) return unavailableProblem(url.pathname);

		const uploader: UploadedPdfUploadService = new UploadedPdfUploadService(
			dependencies.drafts,
			dependencies.objects,
			dependencies.uploadedDocuments
		);
		try {
			const result: CommitDraftResult = await uploader.upload({
				organizationId: authorized.organizationId,
				envelopeId: envelopeIdResult.data,
				expectedGeneration: parsed.expectedGeneration,
				actor: draftActor(authorized),
				idempotencyKey: idempotencyResult.data,
				bytes: parsed.pdfBytes,
				title: parsed.title,
				position: parsed.position
			});
			const revision = {
				generation: result.revision.generation,
				commitSha: result.revision.commitSha,
				archiveSha256: result.revision.archiveSha256
			};
			const headers: Headers = new Headers({
				'cache-control': 'no-store',
				'content-type': 'application/json',
				location: `/api/v1/envelopes/${envelopeIdResult.data}/draft/commits/${revision.commitSha}`
			});
			if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
			return new Response(JSON.stringify({ revision }), { status: 201, headers });
		} catch (error: unknown) {
			if (error instanceof UploadedPdfUploadError) {
				if (error.reason === 'too_large') return tooLarge(url.pathname);
				if (error.reason === 'cap_exceeded') {
					return problemResponse({
						type: 'urn:signkit:problem:envelope-document-set-conflict',
						title: 'Envelope document set conflict',
						status: 409,
						detail: error.message,
						instance: url.pathname
					});
				}
				if (error.reason === 'invalid_pdf') {
					return problemResponse({
						type: 'urn:signkit:problem:validation-failed',
						title: 'PDF upload rejected',
						status: 400,
						detail: error.message,
						instance: url.pathname,
						errors: [{ path: 'file', message: error.pdfReason ?? error.reason }]
					});
				}
			}
			if (error instanceof DraftEnvelopeNotFoundError) return notFoundProblem(url.pathname);
			if (error instanceof DraftIdempotencyConflictError) {
				return problemResponse({
					type: 'urn:signkit:problem:draft-idempotency-conflict',
					title: 'Idempotency key conflict',
					status: 409,
					detail: 'The Idempotency-Key was already used for a different draft command.',
					instance: url.pathname
				});
			}
			if (error instanceof DraftGenerationConflictError) {
				return problemResponse({
					type: 'urn:signkit:problem:draft-generation-conflict',
					title: 'Draft generation conflict',
					status: 409,
					detail: 'The expected draft generation is no longer current.',
					instance: url.pathname
				});
			}
			if (error instanceof DraftEnvelopeImmutableError) {
				return problemResponse({
					type: 'urn:signkit:problem:envelope-state-conflict',
					title: 'Envelope state conflict',
					status: 409,
					detail: 'Only draft envelopes can accept document revisions.',
					instance: url.pathname
				});
			}
			if (error instanceof DraftDocumentSetError) {
				return problemResponse({
					type: 'urn:signkit:problem:envelope-document-set-conflict',
					title: 'Envelope document set conflict',
					status: 409,
					detail: error.message,
					instance: url.pathname
				});
			}
			console.error(
				JSON.stringify({
					event:
						error instanceof DraftIntegrityError
							? 'pdf_upload_integrity_check_failed'
							: 'pdf_upload_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
	};
}
