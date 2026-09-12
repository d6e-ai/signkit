import { resolveCompletionArtifactStatusService } from '$lib/application/completion-artifacts/completion-artifact-runtime';
import { createCompletionArtifactStatusHandler } from '$lib/http/completion-artifact-status';

export const GET = createCompletionArtifactStatusHandler(resolveCompletionArtifactStatusService);
