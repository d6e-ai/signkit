import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodType } from 'zod';
import {
	DraftDocumentNotFoundError,
	DraftEnvelopeNotFoundError,
	DraftIntegrityError,
	DraftRevisionNotFoundError,
	type DraftExactRevision,
	type DraftPersistenceService,
	type DraftRevisionHistoryPage
} from '$lib/application/drafts/draft-persistence';
import type { RevisionDiffResult } from '$lib/domain/revision-diff';
import { isMarkdownPath } from '$lib/domain/envelope';
import { MAX_DRAFT_GENERATION } from '$lib/domain/draft';
import { authorizeScopedInstanceRequest, type AuthorizedApiActor } from './api-key-authorization';
import { validationErrors } from './bounded-json-body';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';

const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
function isRevisionReference(value: string): boolean {
	const normalized = value.toLowerCase();
	if (/^[a-f0-9]{40}$/.test(normalized)) return true;
	return /^\d{1,10}$/.test(normalized) && Number(normalized) <= MAX_DRAFT_GENERATION;
}

const revisionRefSchema: ZodType<string> = z
	.string()
	.trim()
	.refine(
		isRevisionReference,
		'Revision must be a bounded integer generation or 40-character hexadecimal commit SHA'
	);

const listQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.coerce.number().int().min(0).max(MAX_DRAFT_GENERATION).optional()
});

const getQuerySchema = z.object({
	path: z
		.string()
		.trim()
		.max(240)
		.refine(isMarkdownPath, 'Path must identify a Markdown document under documents/')
		.optional()
});

const diffQuerySchema = z.object({
	base: revisionRefSchema.optional(),
	head: revisionRefSchema.optional(),
	format: z.enum(['json', 'text', 'unified']).default('json'),
	includeUnified: z.preprocess((val) => {
		if (typeof val === 'string') {
			if (val.toLowerCase() === 'false' || val === '0') return false;
			if (val.toLowerCase() === 'true' || val === '1') return true;
		}
		return val;
	}, z.boolean().default(true))
});

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type RevisionPersistenceResolver = (
	context: ResolverContext
) =>
	| Pick<DraftPersistenceService, 'listRevisions' | 'readRevision' | 'diffRevisions'>
	| null
	| Promise<Pick<
			DraftPersistenceService,
			'listRevisions' | 'readRevision' | 'diffRevisions'
	  > | null>;

export interface RevisionHttpHandlers {
	list: RequestHandler;
	get: RequestHandler;
	diff: RequestHandler;
}

function envelopeNotFoundProblem(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:envelope-not-found',
		title: 'Envelope not found',
		status: 404,
		detail: 'No envelope was found.',
		instance
	});
}

function revisionNotFoundProblem(
	instance: string,
	detail: string = 'The requested draft revision was not found.'
): Response {
	return problemResponse({
		type: 'urn:signkit:problem:revision-not-found',
		title: 'Revision not found',
		status: 404,
		detail,
		instance
	});
}

function documentNotFoundProblem(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:document-not-found',
		title: 'Document not found',
		status: 404,
		detail: 'The requested document path was not found in this revision.',
		instance
	});
}

function unavailableProblem(
	instance: string,
	detail: string = 'The draft revision service is currently unavailable.'
): Response {
	return problemResponse({
		type: 'urn:signkit:problem:draft-service-unavailable',
		title: 'Draft service unavailable',
		status: 503,
		detail,
		instance
	});
}

export function createRevisionHttpHandlers(
	resolvePersistence: RevisionPersistenceResolver
): RevisionHttpHandlers {
	const list: RequestHandler = async ({ locals, params, platform, url }): Promise<Response> => {
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

		const queryParams = Object.fromEntries(url.searchParams.entries());
		const queryResult = listQuerySchema.safeParse(queryParams);
		if (!queryResult.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'Invalid query parameters for revision list.',
				instance: url.pathname,
				errors: validationErrors(queryResult.error.issues)
			});
		}

		let persistence: Pick<DraftPersistenceService, 'listRevisions'> | null;
		try {
			persistence = await resolvePersistence({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'revision_persistence_resolution_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
		if (persistence === null) return unavailableProblem(url.pathname);

		try {
			const page: DraftRevisionHistoryPage = await persistence.listRevisions({
				envelopeId: envelopeIdResult.data,
				limit: queryResult.data.limit,
				cursor: queryResult.data.cursor
			});

			return new Response(JSON.stringify(page), {
				status: 200,
				headers: {
					'cache-control': 'no-store',
					'content-type': 'application/json'
				}
			});
		} catch (error: unknown) {
			if (error instanceof DraftEnvelopeNotFoundError) {
				return envelopeNotFoundProblem(url.pathname);
			}
			if (error instanceof DraftIntegrityError) {
				return unavailableProblem(
					url.pathname,
					'Draft repository archive failed integrity verification.'
				);
			}

			console.error(
				JSON.stringify({
					event: 'revision_history_list_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
	};

	const get: RequestHandler = async ({
		locals,
		params,
		platform,
		request,
		url
	}): Promise<Response> => {
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

		const revisionRefResult = revisionRefSchema.safeParse(params.revisionRef);
		if (!revisionRefResult.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'The revision reference must be an integer generation or commit SHA.',
				instance: url.pathname,
				errors: validationErrors(revisionRefResult.error.issues)
			});
		}

		const queryParams = Object.fromEntries(url.searchParams.entries());
		const queryResult = getQuerySchema.safeParse(queryParams);
		if (!queryResult.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'Invalid query parameters for revision read.',
				instance: url.pathname,
				errors: validationErrors(queryResult.error.issues)
			});
		}

		let persistence: Pick<DraftPersistenceService, 'readRevision'> | null;
		try {
			persistence = await resolvePersistence({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'revision_persistence_resolution_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
		if (persistence === null) return unavailableProblem(url.pathname);

		try {
			const revision: DraftExactRevision = await persistence.readRevision({
				envelopeId: envelopeIdResult.data,
				revisionRef: revisionRefResult.data,
				path: queryResult.data.path
			});

			const acceptHeader = request.headers.get('accept') ?? '';
			if (
				queryResult.data.path &&
				revision.selectedDocument &&
				(acceptHeader.includes('text/markdown') || acceptHeader.includes('text/plain'))
			) {
				return new Response(revision.selectedDocument.content, {
					status: 200,
					headers: {
						'cache-control': 'no-store',
						'content-type': 'text/markdown; charset=utf-8'
					}
				});
			}

			const body: Record<string, unknown> = {
				generation: revision.generation,
				commitSha: revision.commitSha,
				archiveSha256: revision.archiveSha256,
				timestamp: revision.timestamp,
				message: revision.message,
				actorType: revision.actorType,
				...(revision.provenance ? { provenance: revision.provenance } : {}),
				...(revision.selectedDocument ? { document: revision.selectedDocument } : {}),
				documents: revision.documents,
				documentSet: revision.documentSet
			};

			return new Response(JSON.stringify(body), {
				status: 200,
				headers: {
					'cache-control': 'no-store',
					'content-type': 'application/json'
				}
			});
		} catch (error: unknown) {
			if (error instanceof DraftEnvelopeNotFoundError) {
				return envelopeNotFoundProblem(url.pathname);
			}
			if (error instanceof DraftRevisionNotFoundError) {
				return revisionNotFoundProblem(url.pathname, error.message);
			}
			if (error instanceof DraftDocumentNotFoundError) {
				return documentNotFoundProblem(url.pathname);
			}
			if (error instanceof DraftIntegrityError) {
				return unavailableProblem(
					url.pathname,
					'Draft repository archive failed integrity verification.'
				);
			}

			console.error(
				JSON.stringify({
					event: 'revision_read_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
	};

	const diff: RequestHandler = async ({
		locals,
		params,
		platform,
		request,
		url
	}): Promise<Response> => {
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

		const queryParams = Object.fromEntries(url.searchParams.entries());
		const queryResult = diffQuerySchema.safeParse(queryParams);
		if (!queryResult.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'Invalid query parameters for revision diff.',
				instance: url.pathname,
				errors: validationErrors(queryResult.error.issues)
			});
		}

		let persistence: Pick<DraftPersistenceService, 'diffRevisions'> | null;
		try {
			persistence = await resolvePersistence({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'revision_persistence_resolution_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
		if (persistence === null) return unavailableProblem(url.pathname);

		try {
			const diffResult: RevisionDiffResult = await persistence.diffRevisions({
				envelopeId: envelopeIdResult.data,
				baseRef: queryResult.data.base,
				headRef: queryResult.data.head,
				includeUnified: queryResult.data.includeUnified
			});

			const acceptHeader = request.headers.get('accept') ?? '';
			const requestedTextFormat =
				queryResult.data.format === 'text' ||
				queryResult.data.format === 'unified' ||
				(acceptHeader.includes('text/plain') && url.searchParams.get('format') !== 'json');

			if (requestedTextFormat) {
				return new Response(diffResult.unifiedText, {
					status: 200,
					headers: {
						'cache-control': 'no-store',
						'content-type': 'text/plain; charset=utf-8'
					}
				});
			}

			return new Response(JSON.stringify(diffResult), {
				status: 200,
				headers: {
					'cache-control': 'no-store',
					'content-type': 'application/json'
				}
			});
		} catch (error: unknown) {
			if (error instanceof DraftEnvelopeNotFoundError) {
				return envelopeNotFoundProblem(url.pathname);
			}
			if (error instanceof DraftRevisionNotFoundError) {
				return revisionNotFoundProblem(url.pathname, error.message);
			}
			if (error instanceof DraftIntegrityError) {
				return unavailableProblem(
					url.pathname,
					'Draft repository archive failed integrity verification.'
				);
			}

			console.error(
				JSON.stringify({
					event: 'revision_diff_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
	};

	return {
		list,
		get,
		diff
	};
}
