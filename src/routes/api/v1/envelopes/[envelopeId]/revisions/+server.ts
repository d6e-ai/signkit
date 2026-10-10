import { resolveDraftPersistenceService } from '$lib/application/drafts/runtime';
import { createRevisionHttpHandlers, type RevisionHttpHandlers } from '$lib/http/revisions';

const handlers: RevisionHttpHandlers = createRevisionHttpHandlers(resolveDraftPersistenceService);

export const GET = handlers.list;
