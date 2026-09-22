import type { PageServerLoad } from './$types';
import { resolvePublicCompletionArtifactService } from '$lib/application/completion-delivery/completion-delivery-runtime';
import {
	PublicCompletionArtifactIntegrityError,
	PublicCompletionArtifactNotFoundError,
	PublicCompletionArtifactStorageError,
	type PublicCompletionArtifactService
} from '$lib/application/completion-delivery/public-completion-artifact';
import { isCompletionToken } from '$lib/security/completion-token';

export type CompletionReceiptPageState =
	{ state: 'published'; pdfAvailable: boolean } | { state: 'invalid' } | { state: 'unavailable' };

/**
 * Never returns or logs the raw token: it is read from `params.token` and
 * passed straight into {@link PublicCompletionArtifactService.status}, whose
 * only output is a key-free, digest-free `{ pdfAvailable }` flag. An
 * unknown, expired, revoked, or wrong-purpose token all resolve to the same
 * opaque `invalid` state so this page is never an oracle for grant status.
 */
export const load: PageServerLoad = async ({
	params,
	platform,
	setHeaders
}): Promise<CompletionReceiptPageState> => {
	setHeaders({
		'cache-control': 'private, no-store',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff'
	});

	if (!isCompletionToken(params.token)) {
		return { state: 'invalid' };
	}

	let service: PublicCompletionArtifactService | null;
	try {
		service = await resolvePublicCompletionArtifactService({ platform });
	} catch {
		return { state: 'unavailable' };
	}
	if (service === null) return { state: 'unavailable' };

	try {
		const status = await service.status(params.token);
		return { state: 'published', pdfAvailable: status.pdfAvailable };
	} catch (error: unknown) {
		if (error instanceof PublicCompletionArtifactNotFoundError) {
			return { state: 'invalid' };
		}
		if (
			error instanceof PublicCompletionArtifactIntegrityError ||
			error instanceof PublicCompletionArtifactStorageError
		) {
			return { state: 'unavailable' };
		}
		return { state: 'unavailable' };
	}
};
