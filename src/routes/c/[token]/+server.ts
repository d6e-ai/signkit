import { resolvePublicCompletionArtifactService } from '$lib/application/completion-delivery/completion-delivery-runtime';
import { createPublicCompletionArtifactLinkHandler } from '$lib/http/public-completion-artifact';

export const GET = createPublicCompletionArtifactLinkHandler(
	resolvePublicCompletionArtifactService
);
