import { resolveCompletionAccessReissueApplication } from '$lib/application/completion-delivery/completion-access-reissue-runtime';
import { createCompletionAccessReissueHandler } from '$lib/http/completion-access-reissue';

export const POST = createCompletionAccessReissueHandler(resolveCompletionAccessReissueApplication);
