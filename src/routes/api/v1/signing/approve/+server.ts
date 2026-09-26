import { dev } from '$app/environment';
import {
	resolveRecipientApprovedApplication,
	resolveRecipientCompletedReceiptApplication
} from '$lib/application/signing/runtime';
import { createRecipientApprovedHandler } from '$lib/http/recipient-approved';
import { sealCompletedReceiptSession } from '$lib/server/completed-receipt-session';
import { unsealRecipientSession } from '$lib/server/recipient-session';

export const POST = createRecipientApprovedHandler(
	resolveRecipientApprovedApplication,
	unsealRecipientSession,
	{
		resolveReceiptApplication: resolveRecipientCompletedReceiptApplication,
		sealReceiptSession: sealCompletedReceiptSession,
		allowInsecureLocalDevelopment: dev
	}
);
