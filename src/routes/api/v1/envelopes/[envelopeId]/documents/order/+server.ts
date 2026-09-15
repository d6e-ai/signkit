import { resolveDraftPersistenceService } from '$lib/application/drafts/runtime';
import { createDocumentOrderHandler } from '$lib/http/envelope-document-order';

export const POST = createDocumentOrderHandler(resolveDraftPersistenceService);
