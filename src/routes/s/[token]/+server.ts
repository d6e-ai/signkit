import { resolveRecipientAccessApplication } from '$lib/application/signing/runtime';
import { createRecipientLinkHandler } from '$lib/http/recipient-link';

export const GET = createRecipientLinkHandler(resolveRecipientAccessApplication);
