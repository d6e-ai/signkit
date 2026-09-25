import { resolveRecipientAccessApplication } from '$lib/application/signing/runtime';
import { createRecipientAccessHandler } from '$lib/http/recipient-access';

export const GET = createRecipientAccessHandler(resolveRecipientAccessApplication, undefined, true);
