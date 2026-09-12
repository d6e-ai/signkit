import { resolvePublicCompletionArtifactService } from '$lib/application/completion-delivery/completion-delivery-runtime';
import { createPublicCompletionArtifactApiHandler } from '$lib/http/public-completion-artifact';

export const GET = createPublicCompletionArtifactApiHandler(resolvePublicCompletionArtifactService);
