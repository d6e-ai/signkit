import { resolveDraftPersistenceService } from '$lib/application/drafts/runtime';
import { createDocxImportHandler } from '$lib/http/docx-import';

export const POST = createDocxImportHandler(resolveDraftPersistenceService);
