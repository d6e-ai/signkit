import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import {
	DraftEnvelopeImmutableError,
	DraftEnvelopeNotFoundError,
	DraftGenerationConflictError,
	DraftIdempotencyConflictError,
	DraftIntegrityError,
	type CommitDraftResult,
	type DraftPersistenceService
} from '$lib/application/drafts/draft-persistence';
import { DocxImportService } from '$lib/application/documents/docx-import-service';
import { MAX_DRAFT_GENERATION } from '$lib/domain/draft';
import {
	DocxImportError,
	resolveDocxImportLimits,
	type DocxImportLimits
} from '$lib/adapters/documents/docx-import';
import {
	authorizeScopedOrganizationRequest,
	type AuthorizedApiActor
} from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse, type ProblemValidationError } from './problem';

const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7e]+$/, 'Idempotency-Key must contain visible ASCII characters only');
const markdownPathSchema: ZodType<string> = z
	.string()
	.max(240)
	.regex(
		/^documents\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/,
		'Draft paths must name a Markdown file directly under documents/'
	)
	.refine((path: string): boolean => !path.includes('..'), {
		message: 'Draft paths must not contain ..'
	});
const expectedGenerationSchema: ZodType<number> = z.coerce
	.number()
	.int()
	.min(0)
	.max(MAX_DRAFT_GENERATION - 1);

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type DocxImportPersistenceResolver = (
	context: ResolverContext
) =>
	| Pick<DraftPersistenceService, 'commit'>
	| null
	| Promise<Pick<DraftPersistenceService, 'commit'> | null>;

type ParsedImport =
	| {
			ok: true;
			targetPath: `documents/${string}.md`;
			expectedGeneration: number;
			docxBytes: Uint8Array;
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
		detail: 'The DOCX import could not be committed safely.',
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

async function readBoundedBytes(
	request: Request,
	maxBytes: number
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'too_large' | 'empty' }> {
	const contentLength: string | null = request.headers.get('content-length');
	if (contentLength !== null) {
		const declaredBytes: number = Number(contentLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
			return { ok: false, reason: 'too_large' };
		}
	}
	if (request.body === null) return { ok: false, reason: 'empty' };
	const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes: number = 0;
	try {
		while (true) {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) break;
			totalBytes += result.value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel('request body exceeded the configured limit');
				return { ok: false, reason: 'too_large' };
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	if (totalBytes === 0) return { ok: false, reason: 'empty' };
	const bytes: Uint8Array = new Uint8Array(totalBytes);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes };
}

async function parseImport(
	request: Request,
	url: URL,
	limits: DocxImportLimits
): Promise<ParsedImport> {
	const type: string = mediaType(request);
	if (type === 'multipart/form-data') {
		let form: FormData;
		try {
			form = await request.formData();
		} catch {
			return {
				ok: false,
				response: problemResponse({
					type: 'urn:signkit:problem:invalid-json',
					title: 'Invalid multipart body',
					status: 400,
					detail: 'The multipart DOCX import body could not be parsed.',
					instance: url.pathname
				})
			};
		}
		const fileValue: FormDataEntryValue | null = form.get('file');
		if (!(fileValue instanceof File)) {
			return {
				ok: false,
				response: problemResponse({
					type: 'urn:signkit:problem:validation-failed',
					title: 'Request validation failed',
					status: 400,
					detail: 'DOCX import requires a file field named file.',
					instance: url.pathname,
					errors: [{ path: 'file', message: 'A DOCX file is required' }]
				})
			};
		}
		if (fileValue.size > limits.maxInputBytes) {
			return {
				ok: false,
				response: tooLarge(url.pathname, limits.maxInputBytes)
			};
		}
		const pathResult = markdownPathSchema.safeParse(form.get('targetPath'));
		const generationResult = expectedGenerationSchema.safeParse(form.get('expectedGeneration'));
		if (!pathResult.success || !generationResult.success) {
			return {
				ok: false,
				response: problemResponse({
					type: 'urn:signkit:problem:validation-failed',
					title: 'Request validation failed',
					status: 400,
					detail: 'The DOCX import request did not match the required schema.',
					instance: url.pathname,
					errors: validationErrors([
						...(pathResult.success ? [] : pathResult.error.issues),
						...(generationResult.success ? [] : generationResult.error.issues)
					])
				})
			};
		}
		const docxBytes: Uint8Array = new Uint8Array(await fileValue.arrayBuffer());
		return {
			ok: true,
			targetPath: pathResult.data as `documents/${string}.md`,
			expectedGeneration: generationResult.data,
			docxBytes
		};
	}

	if (type === DOCX_CONTENT_TYPE || type === 'application/octet-stream') {
		const pathResult = markdownPathSchema.safeParse(
			url.searchParams.get('targetPath') ?? url.searchParams.get('path')
		);
		const generationResult = expectedGenerationSchema.safeParse(
			url.searchParams.get('expectedGeneration')
		);
		if (!pathResult.success || !generationResult.success) {
			return {
				ok: false,
				response: problemResponse({
					type: 'urn:signkit:problem:validation-failed',
					title: 'Request validation failed',
					status: 400,
					detail: 'The DOCX import request did not match the required schema.',
					instance: url.pathname,
					errors: validationErrors([
						...(pathResult.success ? [] : pathResult.error.issues),
						...(generationResult.success ? [] : generationResult.error.issues)
					])
				})
			};
		}
		const bodyResult = await readBoundedBytes(request, limits.maxInputBytes);
		if (!bodyResult.ok && bodyResult.reason === 'too_large') {
			return { ok: false, response: tooLarge(url.pathname, limits.maxInputBytes) };
		}
		if (!bodyResult.ok) {
			return {
				ok: false,
				response: problemResponse({
					type: 'urn:signkit:problem:validation-failed',
					title: 'Request validation failed',
					status: 400,
					detail: 'DOCX import requires a non-empty DOCX body.',
					instance: url.pathname,
					errors: [{ path: '$', message: 'A DOCX body is required' }]
				})
			};
		}
		return {
			ok: true,
			targetPath: pathResult.data as `documents/${string}.md`,
			expectedGeneration: generationResult.data,
			docxBytes: bodyResult.bytes
		};
	}

	return {
		ok: false,
		response: problemResponse({
			type: 'urn:signkit:problem:unsupported-media-type',
			title: 'Unsupported media type',
			status: 415,
			detail: 'DOCX import accepts multipart/form-data or a WordprocessingML DOCX body.',
			instance: url.pathname
		})
	};
}

function tooLarge(instance: string, maxBytes: number): Response {
	return problemResponse({
		type: 'urn:signkit:problem:request-body-too-large',
		title: 'Request body too large',
		status: 413,
		detail: `The uploaded DOCX file must not exceed ${maxBytes} bytes.`,
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

export function createDocxImportHandler(
	resolvePersistence: DocxImportPersistenceResolver
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

		const limits: DocxImportLimits = resolveDocxImportLimits(platform);
		const parsed: ParsedImport = await parseImport(request, url, limits);
		if (!parsed.ok) return parsed.response;

		let persistence: Pick<DraftPersistenceService, 'commit'> | null;
		try {
			persistence = await resolvePersistence({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'docx_import_resolution_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
		if (persistence === null) return unavailableProblem(url.pathname);

		const importer: DocxImportService = new DocxImportService(persistence);
		try {
			const result: CommitDraftResult = await importer.importAndCommit({
				organizationId: authorized.organizationId,
				envelopeId: envelopeIdResult.data,
				targetPath: parsed.targetPath,
				expectedGeneration: parsed.expectedGeneration,
				actor: draftActor(authorized),
				idempotencyKey: idempotencyResult.data,
				docxBytes: parsed.docxBytes,
				limits
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
			if (error instanceof DocxImportError) {
				if (error.code === 'too_large' || error.code === 'entry_too_large') {
					return tooLarge(url.pathname, limits.maxInputBytes);
				}
				return problemResponse({
					type: 'urn:signkit:problem:validation-failed',
					title: 'DOCX import rejected',
					status: 400,
					detail: error.message,
					instance: url.pathname,
					errors: [{ path: 'file', message: error.code }]
				});
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
			console.error(
				JSON.stringify({
					event:
						error instanceof DraftIntegrityError
							? 'docx_import_integrity_check_failed'
							: 'docx_import_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
	};
}
