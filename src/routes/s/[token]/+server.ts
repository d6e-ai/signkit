import {
	resolveRecipientAccessApplication,
	resolveRecipientDeclinedReceiptApplication
} from '$lib/application/signing/runtime';
import { createRecipientLinkHandler } from '$lib/http/recipient-link';
import { sealDeclinedReceiptSession } from '$lib/server/declined-receipt-session';

export const GET = createRecipientLinkHandler(
	resolveRecipientAccessApplication,
	undefined,
	undefined,
	undefined,
	{
		resolveApplication: resolveRecipientDeclinedReceiptApplication,
		sealSession: sealDeclinedReceiptSession
	}
);
