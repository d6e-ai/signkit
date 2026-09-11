import { resolveDraftPersistenceService } from '$lib/application/drafts/runtime';
import { createDraftHttpHandlers, type DraftHttpHandlers } from '$lib/http/drafts';

const handlers: DraftHttpHandlers = createDraftHttpHandlers(resolveDraftPersistenceService);

export const POST = handlers.commit;
