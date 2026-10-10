import { dev } from '$app/environment';
import {
	resolveRecipientCompletedReceiptApplication,
	resolveRecipientSignedApplication
} from '$lib/application/signing/runtime';
import { createRecipientSignedHandler } from '$lib/http/recipient-signed';
import { sealCompletedReceiptSession } from '$lib/server/completed-receipt-session';
import { unsealRecipientSession } from '$lib/server/recipient-session';

export const POST = createRecipientSignedHandler(
	resolveRecipientSignedApplication,
	unsealRecipientSession,
	{
		resolveReceiptApplication: resolveRecipientCompletedReceiptApplication,
		sealReceiptSession: sealCompletedReceiptSession,
		allowInsecureLocalDevelopment: dev
	}
);
