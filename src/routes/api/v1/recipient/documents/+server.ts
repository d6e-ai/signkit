import { resolveRecipientWorkspaceApplication } from '$lib/application/signing/runtime';
import { createRecipientDocumentsHandler } from '$lib/http/recipient-documents';

export const GET = createRecipientDocumentsHandler(
	resolveRecipientWorkspaceApplication,
	undefined,
	'bearer'
);
