import { resolveCompletionArtifactRetryService } from '$lib/application/completion-artifacts/completion-artifact-runtime';
import { createCompletionArtifactRetryHandler } from '$lib/http/completion-artifact-retry';

export const POST = createCompletionArtifactRetryHandler(resolveCompletionArtifactRetryService);
