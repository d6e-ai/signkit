import { resolveCompletionArtifactPublicationService } from '$lib/application/completion-artifacts/completion-artifact-runtime';
import { createCompletionArtifactDrainHandler } from '$lib/http/completion-artifact-drain';

export const POST = createCompletionArtifactDrainHandler(
	resolveCompletionArtifactPublicationService
);
