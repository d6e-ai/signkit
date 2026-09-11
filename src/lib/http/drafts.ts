import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import {
	DraftEnvelopeNotFoundError,
	DraftIntegrityError,
	DraftReadConflictError,
	type DraftPersistenceService,
	type DraftWorkspaceSnapshot
} from '$lib/application/drafts/draft-persistence';
import {
	authorizeOrganizationRequest,
	type AuthorizedRequestActor
} from './organization-authorization';
import { problemResponse, type ProblemValidationError } from './problem';

const envelopeIdSchema: ZodType<string> = z.string().uuid();

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type DraftPersistenceResolver = (
	context: ResolverContext
) =>
	| Pick<DraftPersistenceService, 'readWorkspace'>
	| null
	| Promise<Pick<DraftPersistenceService, 'readWorkspace'> | null>;

export interface DraftHttpHandlers {
	get: RequestHandler;
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

function notFoundProblem(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:envelope-not-found',
		title: 'Envelope not found',
		status: 404,
		detail: 'No envelope was found in the authorized organization.',
		instance
	});
}

export function createDraftHttpHandlers(
	resolvePersistence: DraftPersistenceResolver
): DraftHttpHandlers {
	const get: RequestHandler = async ({ locals, params, platform, url }): Promise<Response> => {
		const authorized: AuthorizedRequestActor | Response = authorizeOrganizationRequest(
			locals,
			url.pathname
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

		let persistence: Pick<DraftPersistenceService, 'readWorkspace'> | null;
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
				organizationId: authorized.organizationId,
				envelopeId: envelopeIdResult.data
			});
			const body = {
				generation: workspace.generation,
				commitSha: workspace.commitSha,
				archiveSha256: workspace.archiveSha256,
				documents: workspace.documents
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

	return { get };
}
