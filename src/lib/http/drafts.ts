import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import {
	DraftDocumentSetError,
	DraftEnvelopeImmutableError,
	DraftEnvelopeNotFoundError,
	DraftGenerationConflictError,
	DraftIdempotencyConflictError,
	DraftIntegrityError,
	DraftReadConflictError,
	type CommitDraftResult,
	type DraftCommitProvenance,
	type DraftPersistenceService,
	type DraftWorkspaceSnapshot
} from '$lib/application/drafts/draft-persistence';
import { MAX_DRAFT_GENERATION, normalizeMarkdownContent } from '$lib/domain/draft';
import type { DraftEdit } from '$lib/ports/draft-repository';
import { authorizeScopedInstanceRequest, type AuthorizedApiActor } from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse, type ProblemValidationError } from './problem';

const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7e]+$/, 'Idempotency-Key must contain visible ASCII characters only');
const MAX_COMMIT_BODY_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_CONTENT_BYTES = 512 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 1024 * 1024;
const MAX_EDIT_COUNT = 50;
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
const normalizedMetadataValueSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.refine((value: string): boolean => !hasControlCharacter(value), {
		message: 'Provenance values must not contain control characters'
	});
export const commitDraftSchema = z
	.object({
		expectedGeneration: z
			.number()
			.int()
			.min(0)
			.max(MAX_DRAFT_GENERATION - 1),
		message: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.refine((value: string): boolean => !hasControlCharacter(value), {
				message: 'Commit messages must be a single line without control characters'
			}),
		edits: z
			.array(
				z
					.object({
						path: markdownPathSchema,
						content: z.string().refine((content: string): boolean => !content.includes('\u0000'), {
							message: 'Markdown content must not contain a NUL character'
						})
					})
					.strict()
			)
			.min(1)
			.max(MAX_EDIT_COUNT),
		provenance: z
			.object({
				automationRunId: normalizedMetadataValueSchema.optional(),
				externalId: normalizedMetadataValueSchema.optional()
			})
			.strict()
			.optional()
	})
	.strict()
	.superRefine((input, context): void => {
		const paths: Set<string> = new Set<string>();
		let totalContentBytes: number = 0;
		for (let index: number = 0; index < input.edits.length; index += 1) {
			const edit = input.edits[index];
			if (paths.has(edit.path)) {
				context.addIssue({
					code: 'custom',
					path: ['edits', index, 'path'],
					message: 'Draft paths must be unique within one commit'
				});
			}
			paths.add(edit.path);

			const contentBytes: number = new TextEncoder().encode(
				normalizeMarkdownContent(edit.content)
			).byteLength;
			totalContentBytes += contentBytes;
			if (contentBytes > MAX_EDIT_CONTENT_BYTES) {
				context.addIssue({
					code: 'custom',
					path: ['edits', index, 'content'],
					message: `Markdown content must not exceed ${MAX_EDIT_CONTENT_BYTES} UTF-8 bytes`
				});
			}
		}
		if (totalContentBytes > MAX_TOTAL_CONTENT_BYTES) {
			context.addIssue({
				code: 'custom',
				path: ['edits'],
				message: `Markdown content must not exceed ${MAX_TOTAL_CONTENT_BYTES} total UTF-8 bytes`
			});
		}
	});

type CommitDraftRequest = z.infer<typeof commitDraftSchema>;
type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

function hasControlCharacter(value: string): boolean {
	for (let index: number = 0; index < value.length; index += 1) {
		const code: number = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type DraftPersistenceResolver = (
	context: ResolverContext
) =>
	| Pick<DraftPersistenceService, 'commit' | 'readWorkspace'>
	| null
	| Promise<Pick<DraftPersistenceService, 'commit' | 'readWorkspace'> | null>;

export interface DraftHttpHandlers {
	commit: RequestHandler;
	get: RequestHandler;
}

async function readJsonBody(request: Request): Promise<JsonBodyResult> {
	const contentLength: string | null = request.headers.get('content-length');
	if (contentLength !== null) {
		const declaredBytes: number = Number(contentLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_COMMIT_BODY_BYTES) {
			return { ok: false, reason: 'too_large' };
		}
	}
	if (request.body === null) return { ok: false, reason: 'invalid' };

	const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes: number = 0;
	try {
		while (true) {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) break;
			totalBytes += result.value.byteLength;
			if (totalBytes > MAX_COMMIT_BODY_BYTES) {
				await reader.cancel('request body exceeded the configured limit');
				return { ok: false, reason: 'too_large' };
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes: Uint8Array = new Uint8Array(totalBytes);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		const text: string = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}

function acceptsJson(request: Request): boolean {
	const contentType: string | null = request.headers.get('content-type');
	return contentType?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

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
		detail: 'The draft workspace could not be read safely.',
		instance
	});
}

function commitUnavailableProblem(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:draft-service-unavailable',
		title: 'Draft service unavailable',
		status: 503,
		detail: 'The draft revision could not be committed safely.',
		instance
	});
}

function notFoundProblem(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:envelope-not-found',
		title: 'Envelope not found',
		status: 404,
		detail: 'No envelope was found.',
		instance
	});
}

export function createDraftHttpHandlers(
	resolvePersistence: DraftPersistenceResolver
): DraftHttpHandlers {
	const get: RequestHandler = async ({ locals, params, platform, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedInstanceRequest(
			locals,
			url.pathname,
			'envelopes:read'
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

		let persistence: Pick<DraftPersistenceService, 'commit' | 'readWorkspace'> | null;
		try {
			persistence = await resolvePersistence({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'draft_persistence_resolution_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
		if (persistence === null) return unavailableProblem(url.pathname);

		try {
			const workspace: DraftWorkspaceSnapshot = await persistence.readWorkspace({
				envelopeId: envelopeIdResult.data
			});
			const body = {
				generation: workspace.generation,
				commitSha: workspace.commitSha,
				archiveSha256: workspace.archiveSha256,
				documents: workspace.documents,
				documentSet: workspace.documentSet
			};
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'cache-control': 'no-store', 'content-type': 'application/json' }
			});
		} catch (error: unknown) {
			if (error instanceof DraftEnvelopeNotFoundError) return notFoundProblem(url.pathname);

			console.error(
				JSON.stringify({
					event:
						error instanceof DraftIntegrityError
							? 'draft_integrity_check_failed'
							: error instanceof DraftReadConflictError
								? 'draft_read_conflict'
								: 'draft_workspace_read_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
	};

	const commit: RequestHandler = async ({
		locals,
		params,
		platform,
		request,
		url
	}): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedInstanceRequest(
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

		if (!acceptsJson(request)) {
			return problemResponse({
				type: 'urn:signkit:problem:unsupported-media-type',
				title: 'Unsupported media type',
				status: 415,
				detail: 'Draft commits require an application/json request body.',
				instance: url.pathname
			});
		}

		const bodyResult: JsonBodyResult = await readJsonBody(request);
		if (!bodyResult.ok && bodyResult.reason === 'too_large') {
			return problemResponse({
				type: 'urn:signkit:problem:request-body-too-large',
				title: 'Request body too large',
				status: 413,
				detail: `The request body must not exceed ${MAX_COMMIT_BODY_BYTES} bytes.`,
				instance: url.pathname
			});
		}
		if (!bodyResult.ok) {
			return problemResponse({
				type: 'urn:signkit:problem:invalid-json',
				title: 'Invalid JSON',
				status: 400,
				detail: 'The request body must be valid UTF-8 JSON.',
				instance: url.pathname
			});
		}

		const inputResult = commitDraftSchema.safeParse(bodyResult.value);
		if (!inputResult.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'The draft commit request did not match the required schema.',
				instance: url.pathname,
				errors: validationErrors(inputResult.error.issues)
			});
		}

		let persistence: Pick<DraftPersistenceService, 'commit' | 'readWorkspace'> | null;
		try {
			persistence = await resolvePersistence({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'draft_persistence_resolution_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return commitUnavailableProblem(url.pathname);
		}
		if (persistence === null) return commitUnavailableProblem(url.pathname);

		const input: CommitDraftRequest = inputResult.data;
		const edits: readonly DraftEdit[] = input.edits.map((edit): DraftEdit => ({
			path: edit.path as DraftEdit['path'],
			content: edit.content
		}));
		const provenance: DraftCommitProvenance | undefined = input.provenance;
		try {
			const result: CommitDraftResult = await persistence.commit({
				envelopeId: envelopeIdResult.data,
				actor:
					authorized.authority === 'api_key'
						? {
								id: authorized.id,
								name: 'SignKit agent',
								email: `agent+${authorized.id}@users.noreply.signkit.invalid`,
								type: 'agent' as const
							}
						: {
								id: authorized.id,
								name: authorized.name ?? 'SignKit operator',
								email: authorized.email ?? `user+${authorized.id}@users.noreply.signkit.invalid`,
								type: 'user' as const
							},
				idempotencyKey: idempotencyResult.data,
				expectedGeneration: input.expectedGeneration,
				message: input.message,
				edits,
				...(provenance === undefined ? {} : { provenance })
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
							? 'draft_commit_integrity_check_failed'
							: 'draft_commit_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return commitUnavailableProblem(url.pathname);
		}
	};

	return { commit, get };
}
