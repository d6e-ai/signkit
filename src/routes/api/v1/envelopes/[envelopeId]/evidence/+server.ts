import { resolveCompletionEvidenceService } from '$lib/application/completion-artifacts/completion-artifact-runtime';
import { createCompletionEvidenceHandler } from '$lib/http/completion-evidence';

export const GET = createCompletionEvidenceHandler(resolveCompletionEvidenceService);
