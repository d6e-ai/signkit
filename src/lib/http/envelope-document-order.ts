import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import {
	DraftDocumentSetError,
	DraftEnvelopeImmutableError,
	DraftEnvelopeNotFoundError,
	DraftGenerationConflictError,
	DraftIdempotencyConflictError,
	DraftIntegrityError,
	type CommitDraftResult,
	type DraftPersistenceService
} from '$lib/application/drafts/draft-persistence';
import { MAX_DRAFT_GENERATION } from '$lib/domain/draft';
import { MAX_DOCUMENT_SET_SIZE } from '$lib/domain/document-set';
import { authorizeScopedInstanceRequest, type AuthorizedApiActor } from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_BODY_BYTES: number = 16 * 1024;
const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');
const orderSchema = z
	.object({
		expectedGeneration: z
			.number()
			.int()
			.min(0)
			.max(MAX_DRAFT_GENERATION - 1),
		documentIds: z.array(signkitIdentifierSchema).min(1).max(MAX_DOCUMENT_SET_SIZE)
	})
	.strict()
	.superRefine((value, context): void => {
		const seen: Set<string> = new Set<string>();
		for (const [index, documentId] of value.documentIds.entries()) {
			if (seen.has(documentId)) {
				context.addIssue({
					code: 'custom',
					path: ['documentIds', index],
					message: 'Document IDs must be unique.'
				});
			}
			seen.add(documentId);
		}
	});

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type DocumentOrderPersistenceResolver = (
	context: ResolverContext
) =>
	| Pick<DraftPersistenceService, 'commit'>
	| null
	| Promise<Pick<DraftPersistenceService, 'commit'> | null>;

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

export function createDocumentOrderHandler(
	resolvePersistence: DocumentOrderPersistenceResolver
): RequestHandler {
	return async ({ locals, params, platform, request, url }): Promise<Response> => {
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
				detail: 'Document order commands require an application/json request body.',
				instance: url.pathname
			});
		}

		let body: JsonBodyResult;
		try {
			body = await readJsonBody(request);
		} catch {
			body = { ok: false, reason: 'invalid' };
		}
		if (!body.ok && body.reason === 'too_large') {
			return problemResponse({
				type: 'urn:signkit:problem:request-body-too-large',
				title: 'Request body too large',
				status: 413,
				detail: `The request body must not exceed ${MAX_BODY_BYTES} bytes.`,
				instance: url.pathname
			});
		}
		if (!body.ok) {
			return problemResponse({
				type: 'urn:signkit:problem:invalid-json',
				title: 'Invalid JSON',
				status: 400,
				detail: 'The request body must be valid JSON.',
				instance: url.pathname
			});
		}
		const parsed = orderSchema.safeParse(body.value);
		if (!parsed.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'The document order command did not match the required schema.',
				instance: url.pathname,
				errors: validationErrors(parsed.error.issues)
			});
		}

		let persistence: Pick<DraftPersistenceService, 'commit'> | null;
		try {
			persistence = await resolvePersistence({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'document_order_resolution_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
		if (persistence === null) return unavailableProblem(url.pathname);

		try {
			const result: CommitDraftResult = await persistence.commit({
				envelopeId: envelopeIdResult.data,
				expectedGeneration: parsed.data.expectedGeneration,
				edits: [],
				message: 'Reorder documents',
				actor: draftActor(authorized),
				idempotencyKey: idempotencyResult.data,
				documentSet: { op: 'reorder', documentIds: parsed.data.documentIds }
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
			if (error instanceof DraftEnvelopeNotFoundError) {
				return problemResponse({
					type: 'urn:signkit:problem:envelope-not-found',
					title: 'Envelope not found',
					status: 404,
					detail: 'No envelope was found.',
					instance: url.pathname
				});
			}
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
							? 'document_order_integrity_check_failed'
							: 'document_order_failed',
					error: error instanceof Error ? error.name : 'UnknownError'
				})
			);
			return unavailableProblem(url.pathname);
		}
	};
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

function acceptsJson(request: Request): boolean {
	const type: string =
		request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
	return type === 'application/json';
}

async function readJsonBody(request: Request): Promise<JsonBodyResult> {
	const raw: string = await request.text();
	if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
		return { ok: false, reason: 'too_large' };
	}
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch {
		return { ok: false, reason: 'invalid' };
	}
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
		detail: 'The document order command could not be committed safely.',
		instance
	});
}
