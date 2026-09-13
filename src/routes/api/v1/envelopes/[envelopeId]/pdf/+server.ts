import { resolveCompletionEvidenceService } from '$lib/application/completion-artifacts/completion-artifact-runtime';
import { createCompletionPdfHandler } from '$lib/http/completion-pdf';

export const GET = createCompletionPdfHandler(resolveCompletionEvidenceService);
