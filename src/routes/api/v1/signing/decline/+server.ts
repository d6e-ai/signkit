import { dev } from '$app/environment';
import {
	resolveRecipientDeclinedApplication,
	resolveRecipientDeclinedReceiptApplication
} from '$lib/application/signing/runtime';
import { createRecipientDeclinedHandler } from '$lib/http/recipient-declined';
import { sealDeclinedReceiptSession } from '$lib/server/declined-receipt-session';
import { unsealRecipientSession } from '$lib/server/recipient-session';

export const POST = createRecipientDeclinedHandler(
	resolveRecipientDeclinedApplication,
	unsealRecipientSession,
	{
		resolveReceiptApplication: resolveRecipientDeclinedReceiptApplication,
		sealReceiptSession: sealDeclinedReceiptSession,
		allowInsecureLocalDevelopment: dev
	}
);
