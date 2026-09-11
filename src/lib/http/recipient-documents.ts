import type { RequestHandler } from '@sveltejs/kit';
import { DraftIntegrityError } from '$lib/application/drafts/draft-persistence';
import type {
	RecipientWorkspace,
	RecipientWorkspaceApplicationPort
} from '$lib/application/signing/recipient-workspace';
import { RecipientWorkspaceIntegrityError } from '$lib/application/signing/recipient-workspace';
import { isRecipientCapability } from '$lib/security/recipient-capability';
import { problemResponse } from './problem';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type RecipientWorkspaceApplicationResolver = (
	context: ResolverContext
) => RecipientWorkspaceApplicationPort | null | Promise<RecipientWorkspaceApplicationPort | null>;

export function createRecipientDocumentsHandler(
	resolveApplication: RecipientWorkspaceApplicationResolver,
	now: () => Date = (): Date => new Date()
): RequestHandler {
	return async ({ request, platform, url }): Promise<Response> => {
		const token: string | null = bearerToken(request.headers.get('authorization'));
		if (token === null || !isRecipientCapability(token)) return accessNotFound(url.pathname);

		let application: RecipientWorkspaceApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch {
			console.error(JSON.stringify({ event: 'recipient_documents_resolution_failed' }));
			return unavailable(url.pathname);
		}
		if (application === null) return unavailable(url.pathname);

		try {
			const workspace: RecipientWorkspace | null = await application.resolve(
				token,
				now().toISOString()
			);
			if (workspace === null) return accessNotFound(url.pathname);
			return new Response(
				JSON.stringify({
					access: workspace.access,
					documents: workspace.documents
				}),
				{
					status: 200,
					headers: securityHeaders({ 'content-type': 'application/json' })
				}
			);
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event:
						error instanceof DraftIntegrityError ||
						error instanceof RecipientWorkspaceIntegrityError
							? 'recipient_documents_integrity_failed'
							: 'recipient_documents_failed'
				})
			);
			return unavailable(url.pathname);
		}
	};
}

function bearerToken(authorization: string | null): string | null {
	if (authorization === null || authorization.includes(',')) return null;
	const match: RegExpMatchArray | null = authorization.match(/^Bearer ([^\s]+)$/i);
	return match?.[1] ?? null;
}

function accessNotFound(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:recipient-access-not-found',
			title: 'Recipient access not found',
			status: 404,
			detail: 'No active recipient access was found.',
			instance
		},
		securityHeaders()
	);
}

function unavailable(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:recipient-documents-unavailable',
			title: 'Recipient documents unavailable',
			status: 503,
			detail: 'Recipient documents are temporarily unavailable.',
			instance
		},
		securityHeaders()
	);
}

function securityHeaders(additional: Record<string, string> = {}): Record<string, string> {
	return {
		'cache-control': 'no-store',
		'referrer-policy': 'no-referrer',
		vary: 'Authorization',
		'x-content-type-options': 'nosniff',
		...additional
	};
}
