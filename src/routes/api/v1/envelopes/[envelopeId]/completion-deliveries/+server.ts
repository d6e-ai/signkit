import { resolveCompletionAccessReissueApplication } from '$lib/application/completion-delivery/completion-access-reissue-runtime';
import { createCompletionAccessReissueStatusHandler } from '$lib/http/completion-access-reissue-status';

export const GET = createCompletionAccessReissueStatusHandler(
	resolveCompletionAccessReissueApplication
);
