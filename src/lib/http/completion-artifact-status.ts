import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodType } from 'zod';
import type {
	CompletionArtifactStatusService,
	PublicCompletionArtifactStatus
} from '$lib/application/completion-artifacts/completion-artifact-status';
import {
	authorizeOrganizationRequest,
	type AuthorizedRequestActor
} from './organization-authorization';
import { problemResponse } from './problem';

const envelopeIdSchema: ZodType<string> = z.string().uuid();

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type CompletionArtifactStatusServiceResolver = (
	context: ResolverContext
) => CompletionArtifactStatusService | null | Promise<CompletionArtifactStatusService | null>;

/**
 * Organization-authorized, explicit-allowlist status read. It never returns
 * storage keys, audit hashes, recipient email/name, raw field values,
 * capability material, or internal claim tokens.
 */
export function createCompletionArtifactStatusHandler(
	resolveService: CompletionArtifactStatusServiceResolver
): RequestHandler {
	return async ({ locals, params, platform, url }): Promise<Response> => {
		const authorized: AuthorizedRequestActor | Response = authorizeOrganizationRequest(
			locals,
			url.pathname
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

		let service: CompletionArtifactStatusService | null;
		try {
			service = await resolveService({ platform });
		} catch (error: unknown) {
			logCompletionArtifactStatusError('completion_artifact_status_resolution_failed', error);
			service = null;
		}
		if (service === null) return unavailable(url.pathname);

		try {
			const status: PublicCompletionArtifactStatus | null = await service.find(
				authorized.organizationId,
				envelopeId.data
			);
			if (status === null) {
				return problemResponse({
					type: 'urn:signkit:problem:envelope-not-found',
					title: 'Envelope not found',
					status: 404,
					detail: 'No envelope was found in the authorized organization.',
					instance: url.pathname
				});
			}
			return Response.json(
				{ completionArtifact: status },
				{ headers: { 'cache-control': 'no-store' } }
			);
		} catch (error: unknown) {
			logCompletionArtifactStatusError('completion_artifact_status_failed', error);
			return unavailable(url.pathname);
		}
	};
}

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:completion-artifact-status-unavailable',
		title: 'Completion artifact status unavailable',
		status: 503,
		detail: 'Completion artifact status could not be read.',
		instance
	});
}

function logCompletionArtifactStatusError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
