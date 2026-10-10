import {
	resolveRecipientAccessApplication,
	resolveRecipientCompletedReceiptApplication,
	resolveRecipientDeclinedReceiptApplication
} from '$lib/application/signing/runtime';
import { createRecipientLinkHandler } from '$lib/http/recipient-link';
import { sealDeclinedReceiptSession } from '$lib/server/declined-receipt-session';
import { sealCompletedReceiptSession } from '$lib/server/completed-receipt-session';

export const GET = createRecipientLinkHandler(
	resolveRecipientAccessApplication,
	undefined,
	undefined,
	undefined,
	{
		resolveApplication: resolveRecipientDeclinedReceiptApplication,
		sealSession: sealDeclinedReceiptSession,
		resolveCompletedApplication: resolveRecipientCompletedReceiptApplication,
		sealCompletedSession: sealCompletedReceiptSession
	}
);
